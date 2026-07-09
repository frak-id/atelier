/**
 * Mechanism-only boot. Reshaped from v1 `orchestrators/kernel/sandbox-boot.ts`
 * with every Workspace/policy leak removed:
 *   - no `Workspace` param — takes a resolved `SandboxSpec`;
 *   - no `ports.sshKeys.getValidPublicKeys()` — `authorizedKeys` is an explicit
 *     input (an SSH pubkey is content the caller resolved);
 *   - no `sandboxHasDev` workspace lookup — URLs come from `spec.ports`.
 * The runtime never imports control/ or sessions/.
 */
import { Buffer } from "node:buffer";
import type { SandboxSpec } from "@atelier/spec";
import { customAlphabet } from "nanoid";
import { config } from "../shared/lib/config.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import { type AgentClient, toFileWrites } from "./agent/index.ts";
import { specToAgentConfig } from "./agent-config.ts";
import { cleanupSandboxResources } from "./cleanup.ts";
import {
  buildPvc,
  buildSandboxPod,
  buildSandboxService,
  buildSshPipe,
  ensureSharedSshPipeKey,
  kubeClient,
} from "./kube/index.ts";
import { buildPortIngresses } from "./ports.ts";

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
  /** SSH public keys authorized on the sshpiper Pipe. Content, resolved by the caller. */
  authorizedKeys?: string[];
  /**
   * Full, digest-pinned toolset pull references to materialize into the home
   * before the files/env phase (composed-prebuild-volumes.md §3). Set on fresh
   * `create` only — NOT on resume: a pause snapshot already carries the
   * extracted bytes, and re-extracting would clobber in-session edits.
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
    const sharedKey = await ensureSharedSshPipeKey();

    await kubeClient.createResource(
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

    // local-path uses WaitForFirstConsumer: the PVC binds only when the pod
    // referencing it is scheduled, so there is no separate waitForPvcBound.
    await Promise.all(
      createSandboxResources(sandboxId, spec, {
        image: input.image,
        agentPassword,
        pvcName,
        sharedKeySecret: sharedKey.secretName,
        authorizedKeysData: encodeSshAuthorizedKeys(input.authorizedKeys),
      }),
    );

    const { ready, podIp } = await agent.waitForAgent(sandboxId, {
      timeout: 120_000,
    });
    if (!ready || !podIp) {
      throw new Error(`Sandbox pod ${podName} agent did not become ready`);
    }

    // Materialize toolset artifacts into the home FIRST (before files/env), so
    // spec-level files[] can override org toolset config (last-wins layering).
    if (input.toolsets && input.toolsets.length > 0) {
      await agent.materializeToolsets(sandboxId, input.toolsets);
    }

    // Push config (never ConfigMap-mounted: per-process `env` may carry
    // resolved secrets that must not land in etcd or a pause snapshot) and
    // write files before the phase-ordered hooks/processes the caller drives.
    await agent.putConfig(sandboxId, specToAgentConfig(sandboxId, spec));
    if (spec.files && spec.files.length > 0) {
      await agent.writeFiles(sandboxId, toFileWrites(spec.files));
    }

    return { podName, pvcName, agentPassword, podIp };
  } catch (error) {
    log.error(
      {
        sandboxId,
        error: error instanceof Error ? error.message : String(error),
      },
      "Boot failed, cleaning up allocated resources",
    );
    await cleanupSandboxResources(sandboxId);
    throw error;
  }
}

interface ResourceSpec {
  image: string;
  agentPassword: string;
  pvcName: string;
  sharedKeySecret: string;
  authorizedKeysData?: string;
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
        sshPipeKeySecret: r.sharedKeySecret,
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
    kubeClient.createResource(
      buildSshPipe({
        sandboxId,
        targetHost: `sandbox-${sandboxId}.${config.kubernetes.namespace}.svc`,
        authorizedKeysData: r.authorizedKeysData,
        privateKeySecretName: r.sharedKeySecret,
      }),
    ),
  ];
}

export async function deleteRestartableResources(
  sandboxId: string,
): Promise<void> {
  const podName = `sandbox-${sandboxId}`;
  const deletions: Array<[string, string]> = [
    ["Pod", podName],
    ["Service", `sandbox-${sandboxId}`],
    ["Pipe", `ssh-${sandboxId}`],
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

function encodeSshAuthorizedKeys(publicKeys?: string[]): string | undefined {
  if (!publicKeys || publicKeys.length === 0) return undefined;
  const authorizedKeys = publicKeys.map((key) => key.trim()).join("\n");
  return Buffer.from(authorizedKeys).toString("base64");
}
