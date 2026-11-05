/**
 * Mechanism-only boot, with every Workspace/policy leak removed:
 *   - no `Workspace` param — takes a resolved `SandboxSpec`;
 *   - no `sandboxHasDev` workspace lookup — URLs come from `spec.ports`.
 * The runtime never imports control/ or sessions/.
 */
import type { SandboxSpec } from "@atelier/spec";
import { customAlphabet } from "nanoid";
import { createChildLogger } from "../shared/lib/logger.ts";
import { defaultVolumeSize } from "../shared/lib/runtime-config.ts";
import type { AgentClient } from "./agent/index.ts";
import { provisionAgent } from "./boot-agent.ts";
import { cleanupSandboxResources } from "./cleanup.ts";
import {
  buildPvc,
  buildSandboxPod,
  buildSandboxService,
  ensureSharedSshPipeKey,
  kubeClient,
} from "./kube/index.ts";
import { buildPortIngresses } from "./ports.ts";
import { resourceName } from "./resource-name.ts";

const log = createChildLogger("runtime-boot");

const generatePassword = customAlphabet(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
);

const POD_DELETE_TIMEOUT_MS = 60_000;

export interface BootInput {
  /** Final, resolved OCI image reference for the pod. */
  image: string;
  /** VolumeSnapshot to clone the PVC from (set when booting from a snapshot). */
  snapshotName?: string;
  /** Reuse the sandbox's existing PVC instead of creating one — the resume
   * path: `pause()` deletes the pod but keeps the PVC, so the live disk (not
   * a snapshot clone) is the boot source and a create would 409. */
  reusePvc?: boolean;
  /** On boot failure, tear down only the restartable resources (the pod; the
   * Service and Ingresses stay) instead of the full label sweep — the resume path: the
   * PVC and the pause VolumeSnapshot both carry the sandbox label, and a
   * full sweep would destroy the paused disk a retry needs. */
  preserveDisk?: boolean;
  /**
   * Full, digest-pinned toolset pull references to materialize into the home
   * before the files/env phase (toolset-overlay-squashfs.md §5-6). Set on
   * EVERY boot — create AND resume — and passed to `agent.materializeToolsets`
   * unconditionally, even when empty: materialize is what assembles the
   * `/home/dev` overlay at all (the entrypoint never mounts it — see
   * `sandbox-boot.sh`), so an empty toolset list still needs the call to
   * produce the skel-only overlay. Materialize is mount-only and idempotent
   * under the squashfs+overlay scheme: each ref's blob is pulled to
   * `/data/toolsets` once (skipped if already present — true on resume,
   * since the pause VolumeSnapshot carries `/data` including the blobs) and
   * loop-mounted read-only as an overlay lower over `/data/upper`. Unlike
   * the old extract-into-PVC model, re-running this on resume cannot clobber
   * in-session edits: those live in the writable upper, which the RO lowers
   * never touch.
   */
  toolsets?: string[];
}

export interface BootOutput {
  podName: string;
  pvcName: string;
  agentPassword: string;
  podIp: string;
  /** The sandbox's sshd host public key line(s), as reported by the agent
   * right after boot. See `ProvisionAgentResult` for the exact semantics. */
  sshHostKeys: string[];
}

export async function bootSandbox(
  sandboxId: string,
  spec: SandboxSpec,
  input: BootInput,
  agent: AgentClient,
): Promise<BootOutput> {
  const podName = resourceName(sandboxId);
  const pvcName = podName;
  const usedSnapshot = Boolean(input.snapshotName);
  // Blank only when WE create it here without a snapshot dataSource — a
  // reused (resume) or snapshot-cloned PVC already carries ext4 and must never
  // be formatted (see sandbox-boot.sh's mkfs guard).
  const freshVolume = !input.reusePvc && !usedSnapshot;
  const volumeSize =
    spec.resources.diskGb != null
      ? `${spec.resources.diskGb}Gi`
      : defaultVolumeSize();

  const agentPassword = generatePassword(32);
  // The agent refuses calls without this token and the record doesn't exist
  // yet (nor does one for a throwaway build pod), so hand it to the client
  // before the first agent call.
  agent.setToken(sandboxId, agentPassword);
  // uid of the PVC THIS call created, set only once the API server confirmed
  // the create. The only PVC a failed boot may delete (see the catch below).
  let createdPvcUid: string | undefined;

  try {
    // The pod trusts the shared key's public half as its authorized_keys:
    // the in-server SSH gateway (ssh/) dials `dev@pod` with the private half.
    const sshKey = await ensureSharedSshPipeKey();

    // The PVC is created FIRST, on its own, and everything else only after
    // the API server confirmed it. If that create fails (409: a same-name PVC
    // already exists, e.g. `resume` wrongly concluded there was none), we
    // abort before any pod exists — so no pod ever carries the fresh-volume
    // marker against a disk this call didn't create, and the catch below
    // knows exactly which PVC (by uid) is ours to roll back. It only needs
    // to exist, not be bound: WaitForFirstConsumer binds it when the pod is
    // scheduled, so there is no separate waitForPvcBound.
    if (!input.reusePvc) {
      const pvc = await kubeClient.createResource(
        buildPvc({
          name: pvcName,
          size: volumeSize,
          snapshotName: usedSnapshot ? input.snapshotName : undefined,
          labels: {
            "atelier.dev/sandbox": sandboxId,
            "atelier.dev/component": "sandbox",
          },
        }),
      );
      createdPvcUid = pvc.metadata?.uid;
    }

    // The rest create in one concurrent batch.
    await Promise.all(
      createSandboxResources(sandboxId, spec, {
        image: input.image,
        agentPassword,
        pvcName,
        freshVolume,
        sshKeySecret: sshKey.secretName,
      }),
    );

    // Backend-neutral tail (wait for agent -> materialize -> config -> files);
    // shared with the Docker backend via provisionAgent.
    const { podIp, sshHostKeys } = await provisionAgent(
      sandboxId,
      spec,
      input,
      agent,
    );

    // The SSH gateway pins the sandbox's real sshd host key(s), read off the
    // record (host keys regenerate every boot, see sandbox-boot.sh). A
    // sandbox that reports none fails the boot rather than exposing SSH
    // unverified.
    if (sshHostKeys.length === 0) {
      throw new Error(
        `Sandbox ${sandboxId} reported no sshd host keys; refusing to ` +
          "expose SSH without host-key verification",
      );
    }

    return { podName, pvcName, agentPassword, podIp, sshHostKeys };
  } catch (error) {
    log.error(
      {
        sandboxId,
        error: error instanceof Error ? error.message : String(error),
      },
      "Boot failed, cleaning up allocated resources",
    );
    if (input.preserveDisk) {
      await deleteRestartableResources(sandboxId);
      // A resume that booted from scratch (no PVC, no snapshot) created a
      // blank PVC in THIS call; it holds no user data. Keeping it would make
      // the retry reuse it WITHOUT the fresh marker, and if this boot died
      // before mkfs (e.g. pod Pending past the agent wait during a kata
      // upgrade), sandbox-boot.sh would refuse the unformatted disk forever.
      // Drop it so the retry recreates it fresh. The pod is already gone
      // (deleteRestartableResources waits), so pvc-protection won't stall.
      //
      // Only ever the PVC this call CREATED: no confirmed create (it 409'd,
      // errored, or never ran) means no uid and no delete — a same-name PVC
      // we didn't make may hold a workspace. The uid precondition makes the
      // API server enforce that too.
      if (freshVolume && createdPvcUid) {
        await deleteFreshPvc(sandboxId, pvcName, createdPvcUid);
      }
    } else await cleanupSandboxResources(sandboxId);
    throw error;
  }
}

async function deleteFreshPvc(
  sandboxId: string,
  pvcName: string,
  uid: string,
): Promise<void> {
  try {
    await kubeClient.deleteResource(
      "PersistentVolumeClaim",
      pvcName,
      undefined,
      { preconditions: { uid } },
    );
    const gone = await kubeClient.waitForResourceDeleted(
      "PersistentVolumeClaim",
      pvcName,
      { timeout: POD_DELETE_TIMEOUT_MS },
    );
    if (!gone) {
      log.warn(
        { sandboxId, pvcName },
        "Blank PVC still terminating after a failed from-scratch resume; a retry before it is gone may refuse the unformatted disk",
      );
    }
  } catch (error) {
    log.warn(
      {
        sandboxId,
        pvcName,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to drop the blank PVC after a failed from-scratch resume; a retry may refuse the unformatted disk",
    );
  }
}

interface ResourceSpec {
  image: string;
  agentPassword: string;
  pvcName: string;
  /** The PVC was just created blank — the only case the guest may mkfs it. */
  freshVolume: boolean;
  /** Secret the pod mounts as its authorized_keys source (the shared key the
   * SSH gateway dials with). */
  sshKeySecret: string;
}

function createSandboxResources(
  sandboxId: string,
  spec: SandboxSpec,
  r: ResourceSpec,
) {
  return [
    kubeClient.createResource(
      buildSandboxPod({
        sandboxId,
        image: r.image,
        agentPassword: r.agentPassword,
        pvcName: r.pvcName,
        freshVolume: r.freshVolume,
        sshPipeKeySecret: r.sshKeySecret,
        requests: {
          cpu: `${Math.max(250, spec.resources.vcpus * 250)}m`,
          memory: `${spec.resources.memoryMb}Mi`,
        },
        limits: {
          cpu: `${spec.resources.vcpus * 1000}m`,
          memory: `${spec.resources.memoryMb}Mi`,
        },
      }),
    ),
    kubeClient.applyResource(
      buildSandboxService(sandboxId, { ports: spec.ports ?? [] }),
    ),
    ...buildPortIngresses(sandboxId, spec.ports).map((resource) =>
      kubeClient.applyResource(resource),
    ),
  ];
}

export async function deleteRestartableResources(
  sandboxId: string,
): Promise<void> {
  // Only the pod: the Service and Ingresses stay, so a paused sandbox's tool
  // URLs still reach the ingress and its forward-auth/wake middleware, which
  // resumes it (a Service without endpoints answers 503, after the
  // middleware ran). `bootSandbox` applies them again on resume.
  const podName = resourceName(sandboxId);
  try {
    await kubeClient.deleteResource("Pod", podName);
  } catch {}
  await kubeClient.waitForResourceDeleted("Pod", podName, {
    timeout: POD_DELETE_TIMEOUT_MS,
  });
}
