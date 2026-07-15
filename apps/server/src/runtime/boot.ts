/**
 * Mechanism-only boot, with every Workspace/policy leak removed:
 *   - no `Workspace` param — takes a resolved `SandboxSpec`;
 *   - no `ports.sshKeys.getValidPublicKeys()` — `authorizedKeys` is an explicit
 *     input (an SSH pubkey is content the caller resolved);
 *   - no `sandboxHasDev` workspace lookup — URLs come from `spec.ports`.
 * The runtime never imports control/ or sessions/.
 */
import type { SandboxSpec } from "@atelier/spec";
import { customAlphabet } from "nanoid";
import { config } from "../shared/lib/config.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import type { AgentClient } from "./agent/index.ts";
import { provisionAgent } from "./boot-agent.ts";
import { cleanupSandboxResources } from "./cleanup.ts";
import {
  buildPvc,
  buildSandboxPod,
  buildSandboxService,
  type KubeResource,
  kubeClient,
} from "./kube/index.ts";
import { buildPortIngresses } from "./ports.ts";
import { resolveSshGatewayBoot, sshAuthKeysSecretName } from "./ssh-gateway.ts";

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
  /** On boot failure, tear down only the restartable resources (pod/service/
   * pipe/ingresses) instead of the full label sweep — the resume path: the
   * PVC and the pause VolumeSnapshot both carry the sandbox label, and a
   * full sweep would destroy the paused disk a retry needs. */
  preserveDisk?: boolean;
  /** SSH public keys authorized on the sshpiper Pipe. Content, resolved by the caller. */
  authorizedKeys?: string[];
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
}

export async function bootSandbox(
  sandboxId: string,
  spec: SandboxSpec,
  input: BootInput,
  agent: AgentClient,
): Promise<BootOutput> {
  const podName = `sandbox-${sandboxId}`;
  const pvcName = `sandbox-${sandboxId}`;
  const usedSnapshot = Boolean(input.snapshotName);
  const volumeSize =
    spec.resources.diskGb != null
      ? `${spec.resources.diskGb}Gi`
      : config.kubernetes.defaultVolumeSize;

  const agentPassword = generatePassword(32);

  try {
    // The SSH gateway strategy decides which secret the pod trusts as its
    // authorized_keys and what extra SSH resources to emit (Pipe / per-sandbox
    // key Secret) — sshpiper is optional (proposal §5).
    const ssh = await resolveSshGatewayBoot(sandboxId, input.authorizedKeys);

    // All resources create in one concurrent batch, PVC included: a pod may
    // reference a PVC that doesn't exist yet (it just stays unschedulable
    // until the PVC-add event requeues it — level-triggered, same as
    // StatefulSets), and within this batch the PVC create lands well before
    // the pod is scheduled. local-path uses WaitForFirstConsumer: the PVC
    // binds only when the pod referencing it is scheduled, so there is no
    // separate waitForPvcBound.
    await Promise.all([
      input.reusePvc
        ? undefined
        : kubeClient.createResource(
            buildPvc({
              name: pvcName,
              size: volumeSize,
              snapshotName: usedSnapshot ? input.snapshotName : undefined,
              labels: {
                "atelier.dev/sandbox": sandboxId,
                "atelier.dev/component": "sandbox",
              },
            }),
          ),
      ...createSandboxResources(sandboxId, spec, {
        image: input.image,
        agentPassword,
        pvcName,
        podAuthKeysSecret: ssh.podAuthKeysSecret,
        sshResources: ssh.resources,
      }),
    ]);

    // Backend-neutral tail (wait for agent -> materialize -> config -> files);
    // shared with the Docker backend via provisionAgent.
    const podIp = await provisionAgent(sandboxId, spec, input, agent);

    return { podName, pvcName, agentPassword, podIp };
  } catch (error) {
    log.error(
      {
        sandboxId,
        error: error instanceof Error ? error.message : String(error),
      },
      "Boot failed, cleaning up allocated resources",
    );
    if (input.preserveDisk) await deleteRestartableResources(sandboxId);
    else await cleanupSandboxResources(sandboxId);
    throw error;
  }
}

interface ResourceSpec {
  image: string;
  agentPassword: string;
  pvcName: string;
  /** Secret the pod mounts as its authorized_keys source (resolved by the SSH
   * gateway strategy); undefined disables in-pod SSH. */
  podAuthKeysSecret?: string;
  /** SSH gateway resources to create alongside the pod (Pipe / key Secret). */
  sshResources: KubeResource[];
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
        sshPipeKeySecret: r.podAuthKeysSecret,
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
    kubeClient.createResource(
      buildSandboxService(sandboxId, { ports: spec.ports ?? [] }),
    ),
    ...buildPortIngresses(sandboxId, spec.ports).map((resource) =>
      kubeClient.createResource(resource),
    ),
    ...r.sshResources.map((resource) => kubeClient.createResource(resource)),
  ];
}

export async function deleteRestartableResources(
  sandboxId: string,
): Promise<void> {
  const podName = `sandbox-${sandboxId}`;
  const deletions: Array<[string, string]> = [
    ["Pod", podName],
    ["Service", `sandbox-${sandboxId}`],
    // Both SSH-gateway restartable resources: the sshpiper Pipe and the `none`
    // strategy's per-sandbox authorized-keys Secret. Deleting a non-existent
    // one is a no-op (swallowed below), so this is strategy-agnostic.
    ["Pipe", `ssh-${sandboxId}`],
    ["Secret", sshAuthKeysSecretName(sandboxId)],
  ];
  for (const [kind, name] of deletions) {
    try {
      await kubeClient.deleteResource(kind, name);
    } catch {}
  }
  try {
    await kubeClient.deleteLabeledIngresses(`atelier.dev/sandbox=${sandboxId}`);
  } catch {}
  await kubeClient.waitForResourceDeleted("Pod", podName, {
    timeout: POD_DELETE_TIMEOUT_MS,
  });
}
