import { Buffer } from "node:buffer";
import { customAlphabet } from "nanoid";
import { eventBus } from "../../infrastructure/events/index.ts";
import {
  buildConfigMap,
  buildPvc,
  buildSandboxPod,
  buildSandboxService,
  buildSshPipe,
  collectDevPorts,
  ensureSharedSshPipeKey,
  kubeClient,
} from "../../infrastructure/kubernetes/index.ts";
import type {
  Sandbox,
  SandboxOrigin,
  SandboxUrls,
  Workspace,
} from "../../schemas/index.ts";
import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import type { SandboxPorts } from "../ports/sandbox-ports.ts";
import {
  buildSandboxConfig,
  type OpencodeWorkspaceContext,
} from "../sandbox-config.ts";
import {
  buildToolIngressResources,
  listToolInfos,
  toolIngressNames,
} from "../tools/registry.ts";
import { cleanupSandboxResources } from "./cleanup-coordinator.ts";

const log = createChildLogger("sandbox-boot");

const generatePassword = customAlphabet(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
);

const DEFAULT_BASE_IMAGE = "dev-base";
const POD_DELETE_TIMEOUT_MS = 60_000;

export interface BootNewOptions {
  workspaceId?: string;
  baseImage?: string;
  vcpus: number;
  memoryMb: number;
  prebuildReady: boolean;
  /** VolumeSnapshot name to clone PVC from (set when prebuild is ready) */
  prebuildSnapshotName?: string;
  /** PVC size override (K8s quantity, e.g. "10Gi") */
  volumeSize?: string;
  workspace?: Workspace;
  /** Optional display name shown on the dashboard. Defaults to workspace name. */
  name?: string;
  /** Where the sandbox came from (display + integration recovery). */
  origin?: SandboxOrigin;
  /** User who triggered the spawn. */
  createdBy?: string;
  /**
   * Workspace-mode context forwarded by the local opencode-atelier plugin.
   * Required for cross-machine session warp to land its FK-bound rows.
   * See `OpencodeWorkspaceContext` for the per-field rationale.
   */
  opencodeWorkspaceContext?: OpencodeWorkspaceContext;
}

export interface BootResult {
  sandbox: Sandbox;
  podName: string;
  pvcName: string;
  usedPrebuild: boolean;
}

export interface RestartResult {
  podName: string;
  agentReady: boolean;
}

export async function bootNewSandbox(
  sandboxId: string,
  options: BootNewOptions,
  ports: SandboxPorts,
): Promise<BootResult> {
  const podName = `sandbox-${sandboxId}`;
  const pvcName = `sandbox-${sandboxId}`;
  const configMapName = `sandbox-config-${sandboxId}`;
  const usedPrebuild = Boolean(
    options.prebuildReady && options.prebuildSnapshotName,
  );
  const image = resolveSandboxImage(options.baseImage);
  const volumeSize = options.volumeSize ?? config.kubernetes.defaultVolumeSize;

  const opencodePassword = generatePassword(32);
  const sandbox: Sandbox = {
    id: sandboxId,
    status: "creating",
    workspaceId: options.workspaceId,
    createdBy: options.createdBy,
    name: options.name ?? options.workspace?.name,
    origin: options.origin,
    runtime: {
      ipAddress: "",
      macAddress: "",
      urls: { vscode: "", opencode: "", ssh: "" },
      vcpus: options.vcpus,
      memoryMb: options.memoryMb,
      opencodePassword,
    },
    // Persisted so the restart path can rehydrate workspace mode without
    // needing the local opencode-atelier plugin to re-supply the env.
    opencodeWorkspaceContext: options.opencodeWorkspaceContext,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  ports.sandbox.create(sandbox);

  try {
    const sharedKey = await ensureSharedSshPipeKey();

    await kubeClient.createResource(
      buildPvc({
        name: pvcName,
        size: volumeSize,
        snapshotName: usedPrebuild ? options.prebuildSnapshotName : undefined,
        labels: {
          "atelier.dev/sandbox": sandboxId,
          "atelier.dev/component": "sandbox",
        },
      }),
    );

    // Note: no waitForPvcBound — local-path uses WaitForFirstConsumer,
    // so the PVC binds only when a pod referencing it is scheduled.
    await Promise.all(
      createSandboxResources(sandboxId, {
        workspaceId: options.workspaceId,
        image,
        opencodePassword,
        pvcName,
        configMapName,
        configJson: JSON.stringify(
          buildSandboxConfig(
            sandboxId,
            options.workspace,
            opencodePassword,
            options.opencodeWorkspaceContext,
          ),
        ),
        devPorts: collectDevPorts(options.workspace?.config.devCommands),
        vcpus: options.vcpus,
        memoryMb: options.memoryMb,
        sharedKeySecret: sharedKey.secretName,
        authorizedKeysData: encodeSshAuthorizedKeys(
          ports.sshKeys.getValidPublicKeys(),
        ),
      }),
    );

    // Single wait: agent health check implies pod is ready and has an IP
    const { ready: agentReady, podIp } = await ports.agent.waitForAgent(
      sandboxId,
      { timeout: 120_000 },
    );
    if (!agentReady) {
      throw new Error(`Sandbox pod ${podName} agent did not become ready`);
    }
    if (podIp) {
      sandbox.runtime.ipAddress = podIp;
    }

    return { sandbox, podName, pvcName, usedPrebuild };
  } catch (error) {
    log.error(
      {
        sandboxId,
        error: error instanceof Error ? error.message : String(error),
      },
      "Boot failed, cleaning up allocated resources",
    );
    await cleanupSandboxResources(sandboxId, { podName });
    throw error;
  }
}

export async function bootExistingSandbox(
  sandboxId: string,
  sandbox: Sandbox,
  ports: SandboxPorts,
): Promise<RestartResult> {
  const podName = `sandbox-${sandboxId}`;
  const pvcName = `sandbox-${sandboxId}`;
  const configMapName = `sandbox-config-${sandboxId}`;

  const workspace = sandbox.workspaceId
    ? ports.workspaces.getById(sandbox.workspaceId)
    : undefined;
  const image = resolveSandboxImage(workspace?.config.baseImage);
  const opencodePassword =
    sandbox.runtime.opencodePassword ?? generatePassword(32);

  await deleteRestartableSandboxResources(sandboxId, configMapName);

  const sharedKey = await ensureSharedSshPipeKey();

  await Promise.all(
    createSandboxResources(sandboxId, {
      workspaceId: sandbox.workspaceId,
      image,
      opencodePassword,
      pvcName,
      configMapName,
      // Restart path: rehydrate the workspace context captured at create time
      // by the local opencode-atelier plugin, else the restarted sandbox loses
      // workspace mode + the preregister env and `/sync/replay` FK-fails again.
      configJson: JSON.stringify(
        buildSandboxConfig(
          sandboxId,
          workspace,
          opencodePassword,
          sandbox.opencodeWorkspaceContext,
        ),
      ),
      devPorts: collectDevPorts(workspace?.config.devCommands),
      vcpus: sandbox.runtime.vcpus,
      memoryMb: sandbox.runtime.memoryMb,
      sharedKeySecret: sharedKey.secretName,
      authorizedKeysData: encodeSshAuthorizedKeys(
        ports.sshKeys.getValidPublicKeys(),
      ),
    }),
  );

  // Single wait: agent health check implies pod is ready and has an IP
  const { ready: agentReady, podIp } = await ports.agent.waitForAgent(
    sandboxId,
    { timeout: 120_000 },
  );
  if (!agentReady) {
    throw new Error(
      `Sandbox pod ${podName} agent did not become ready after restart`,
    );
  }
  if (podIp) {
    sandbox.runtime.ipAddress = podIp;
  }

  return { podName, agentReady };
}

export async function finalizeNewSandbox(
  sandboxId: string,
  sandbox: Sandbox,
  podName: string,
  ports: SandboxPorts,
): Promise<Sandbox> {
  const urls = buildUrls(sandboxId);

  sandbox.status = "running";
  sandbox.runtime.urls = urls;
  sandbox.updatedAt = new Date().toISOString();

  ports.sandbox.update(sandboxId, sandbox);
  eventBus.emit({
    type: "sandbox.created",
    properties: {
      id: sandboxId,
      workspaceId: sandbox.workspaceId,
    },
  });

  log.info({ sandboxId, podName }, "Sandbox created successfully");
  return sandbox;
}

export async function finalizeRestartedSandbox(
  sandboxId: string,
  sandbox: Sandbox,
  podName: string,
  ports: SandboxPorts,
): Promise<Sandbox> {
  const updatedSandbox: Sandbox = {
    ...sandbox,
    status: "running",
    runtime: {
      ...sandbox.runtime,
      urls: buildUrls(sandboxId),
    },
    updatedAt: new Date().toISOString(),
  };

  ports.sandbox.update(sandboxId, updatedSandbox);
  eventBus.emit({
    type: "sandbox.updated",
    properties: { id: sandboxId, status: "running" },
  });
  log.info({ sandboxId, podName }, "Sandbox started");

  return updatedSandbox;
}

function resolveSandboxImage(baseImage?: string): string {
  return `${config.kubernetes.registryUrl}/${baseImage ?? DEFAULT_BASE_IMAGE}:latest`;
}

function buildUrls(sandboxId: string): SandboxUrls {
  const sshHost =
    config.domain.ssh.hostname || `ssh.${config.domain.baseDomain}`;
  const sshPort = config.domain.ssh.port;

  const toolUrls: Record<string, string> = {};
  for (const tool of listToolInfos(sandboxId)) {
    if (tool.url) toolUrls[tool.slug] = tool.url;
  }

  return {
    vscode: toolUrls.vscode ?? "",
    opencode: toolUrls.opencode ?? "",
    ...(toolUrls.browser ? { browser: toolUrls.browser } : {}),
    ssh:
      sshPort === 22
        ? `ssh ${sandboxId}@${sshHost}`
        : `ssh ${sandboxId}@${sshHost} -p ${sshPort}`,
  };
}

function encodeSshAuthorizedKeys(publicKeys: string[]): string | undefined {
  if (publicKeys.length === 0) return undefined;
  const authorizedKeys = publicKeys.map((key) => key.trim()).join("\n");
  return Buffer.from(authorizedKeys).toString("base64");
}

interface SandboxResourceSpec {
  workspaceId?: string;
  image: string;
  opencodePassword: string;
  pvcName: string;
  configMapName: string;
  configJson: string;
  devPorts: Array<{ name: string; port: number }>;
  vcpus: number;
  memoryMb: number;
  sharedKeySecret: string;
  authorizedKeysData?: string;
}

/**
 * The pod-adjacent resources both spawn and restart create identically
 * (ConfigMap, Pod, Service, tool ingresses, SSH pipe). Returned as an array of
 * in-flight creates so callers can `Promise.all` them; the PVC is the caller's
 * concern (spawn creates it, restart reuses it).
 */
function createSandboxResources(
  sandboxId: string,
  spec: SandboxResourceSpec,
) {
  const labels = {
    "atelier.dev/sandbox": sandboxId,
    "atelier.dev/component": "sandbox",
  };

  return [
    kubeClient.createResource(
      buildConfigMap(
        spec.configMapName,
        { "config.json": spec.configJson },
        undefined,
        labels,
      ),
    ),
    kubeClient.createResource(
      buildSandboxPod({
        sandboxId,
        image: spec.image,
        opencodePassword: spec.opencodePassword,
        workspaceId: spec.workspaceId,
        pvcName: spec.pvcName,
        configMapName: spec.configMapName,
        devPorts: spec.devPorts.map((dp) => dp.port),
        sshPipeKeySecret: spec.sharedKeySecret,
        requests: {
          cpu: `${Math.max(250, spec.vcpus * 250)}m`,
          memory: `${spec.memoryMb}Mi`,
        },
        limits: {
          cpu: `${spec.vcpus * 1000}m`,
          memory: `${spec.memoryMb}Mi`,
        },
      }),
    ),
    kubeClient.createResource(
      buildSandboxService(sandboxId, { devPorts: spec.devPorts }),
    ),
    ...buildToolIngressResources(sandboxId).map((resource) =>
      kubeClient.createResource(resource),
    ),
    kubeClient.createResource(
      buildSshPipe({
        sandboxId,
        targetHost: `sandbox-${sandboxId}.${config.kubernetes.namespace}.svc`,
        authorizedKeysData: spec.authorizedKeysData,
        privateKeySecretName: spec.sharedKeySecret,
        workspaceId: spec.workspaceId,
      }),
    ),
  ];
}

async function deleteRestartableSandboxResources(
  sandboxId: string,
  configMapName: string,
): Promise<void> {
  const podName = `sandbox-${sandboxId}`;
  const deletions: Array<[string, string]> = [
    ["Pod", podName],
    ["ConfigMap", configMapName],
    ["Service", `sandbox-${sandboxId}`],
    ...toolIngressNames(sandboxId).map(
      (name) => ["Ingress", name] as [string, string],
    ),
    ["Pipe", `ssh-${sandboxId}`],
  ];

  for (const [kind, name] of deletions) {
    try {
      await kubeClient.deleteResource(kind, name);
    } catch {}
  }

  // Kata pods take seconds to terminate; creating a pod with the same name
  // while the old one is still Terminating 409s. Wait it out before recreating
  // (the prebuild path learned this same lesson).
  await kubeClient.waitForResourceDeleted("Pod", podName, {
    timeout: POD_DELETE_TIMEOUT_MS,
  });
}
