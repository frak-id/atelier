import { customAlphabet } from "nanoid";
import { eventBus } from "../../infrastructure/events/index.ts";
import {
  buildConfigMap,
  buildOpenCodeIngress,
  buildPvc,
  buildSandboxPod,
  buildSandboxService,
  buildVsCodeIngress,
  kubeClient,
} from "../../infrastructure/kubernetes/index.ts";
import type { Sandbox, Workspace } from "../../schemas/index.ts";
import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import type { SandboxPorts } from "../ports/sandbox-ports.ts";
import { buildSandboxConfig } from "../sandbox-config.ts";
import { cleanupSandboxResources } from "./cleanup-coordinator.ts";

const log = createChildLogger("sandbox-boot");

const generatePassword = customAlphabet(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
);

const DEFAULT_BASE_IMAGE = "dev-base";

export interface BootNewOptions {
  workspaceId?: string;
  system?: boolean;
  baseImage?: string;
  vcpus: number;
  memoryMb: number;
  prebuildReady: boolean;
  /** VolumeSnapshot name to clone PVC from (set when prebuild is ready) */
  prebuildSnapshotName?: string;
  /** PVC size override (K8s quantity, e.g. "10Gi") */
  volumeSize?: string;
  workspace?: Workspace;
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
    runtime: {
      ipAddress: "",
      macAddress: "",
      urls: { vscode: "", opencode: "", ssh: "" },
      vcpus: options.vcpus,
      memoryMb: options.memoryMb,
      opencodePassword,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  ports.sandbox.create(sandbox);

  try {
    const sandboxLabels = {
      "atelier.dev/sandbox": sandboxId,
      "atelier.dev/component": "sandbox",
    };

    await kubeClient.createResource(
      buildPvc({
        name: pvcName,
        size: volumeSize,
        snapshotName: usedPrebuild ? options.prebuildSnapshotName : undefined,
        labels: sandboxLabels,
      }),
    );

    // Note: no waitForPvcBound — local-path uses WaitForFirstConsumer,
    // so the PVC binds only when a pod referencing it is scheduled.
    await Promise.all([
      kubeClient.createResource(
        buildConfigMap(
          configMapName,
          {
            "config.json": JSON.stringify(
              buildSandboxConfig(
                sandboxId,
                options.workspace,
                opencodePassword,
              ),
            ),
          },
          undefined,
          sandboxLabels,
        ),
      ),
      kubeClient.createResource(
        buildSandboxPod({
          sandboxId,
          image,
          opencodePassword,
          workspaceId: options.workspaceId,
          pvcName,
          configMapName,
          requests: {
            cpu: `${Math.max(250, options.vcpus * 250)}m`,
            memory: `${options.memoryMb}Mi`,
          },
          limits: {
            cpu: `${options.vcpus * 1000}m`,
            memory: `${options.memoryMb}Mi`,
          },
        }),
      ),
      kubeClient.createResource(buildSandboxService(sandboxId)),
      kubeClient.createResource(
        buildVsCodeIngress(sandboxId, config.domain.dashboard, {
          ingressClassName: config.kubernetes.ingressClassName || undefined,
          annotations: config.kubernetes.vsCodeIngressAnnotations,
          tlsSecretName: "atelier-sandbox-wildcard-tls",
        }),
      ),
      kubeClient.createResource(
        buildOpenCodeIngress(sandboxId, config.domain.dashboard, {
          ingressClassName: config.kubernetes.ingressClassName || undefined,
          annotations: config.kubernetes.openCodeIngressAnnotations,
          tlsSecretName: "atelier-sandbox-wildcard-tls",
        }),
      ),
    ]);

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

  try {
    await kubeClient.deleteResource("Pod", podName);
  } catch {}
  try {
    await kubeClient.deleteResource("ConfigMap", configMapName);
  } catch {}

  const sandboxConfig = buildSandboxConfig(
    sandboxId,
    workspace,
    opencodePassword,
  );

  await Promise.all([
    kubeClient.createResource(
      buildConfigMap(
        configMapName,
        { "config.json": JSON.stringify(sandboxConfig) },
        undefined,
        {
          "atelier.dev/sandbox": sandboxId,
          "atelier.dev/component": "sandbox",
        },
      ),
    ),
    kubeClient.createResource(
      buildSandboxPod({
        sandboxId,
        image,
        opencodePassword,
        workspaceId: sandbox.workspaceId,
        pvcName,
        configMapName,
        requests: {
          cpu: `${Math.max(250, sandbox.runtime.vcpus * 250)}m`,
          memory: `${sandbox.runtime.memoryMb}Mi`,
        },
        limits: {
          cpu: `${sandbox.runtime.vcpus * 1000}m`,
          memory: `${sandbox.runtime.memoryMb}Mi`,
        },
      }),
    ),
  ]);

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
  options: { system?: boolean },
): Promise<Sandbox> {
  const urls = buildUrls(sandboxId, options.system);

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
  options: { system?: boolean },
): Promise<Sandbox> {
  const updatedSandbox: Sandbox = {
    ...sandbox,
    status: "running",
    runtime: {
      ...sandbox.runtime,
      urls: buildUrls(sandboxId, options.system),
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

function buildUrls(
  sandboxId: string,
  system?: boolean,
): { vscode: string; opencode: string; ssh: string } {
  const sandboxDomain = config.domain.dashboard;

  return {
    vscode: system ? "" : `https://vscode-${sandboxId}.${sandboxDomain}`,
    opencode: `https://opencode-${sandboxId}.${sandboxDomain}`,
    ssh: "",
  };
}
