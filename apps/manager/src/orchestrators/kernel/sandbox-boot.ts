import { customAlphabet } from "nanoid";
import { eventBus } from "../../infrastructure/events/index.ts";
import {
  buildSandboxIngress,
  buildSandboxPod,
  buildSandboxService,
  KubeClient,
} from "../../infrastructure/kubernetes/index.ts";
import type { Sandbox } from "../../schemas/index.ts";
import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import type { SandboxPorts } from "../ports/sandbox-ports.ts";
import { waitForPodIp } from "./boot-waiter.ts";
import { cleanupSandboxResources } from "./cleanup-coordinator.ts";

const log = createChildLogger("sandbox-boot");

const generatePassword = customAlphabet(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
);

const REGISTRY_URL = "zot.atelier-system.svc:5000";
const DEFAULT_BASE_IMAGE = "dev-base";

export interface BootNewOptions {
  workspaceId?: string;
  system?: boolean;
  baseImage?: string;
  vcpus: number;
  memoryMb: number;
  prebuildReady: boolean;
}

export interface BootResult {
  sandbox: Sandbox;
  podName: string;
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
  const kube = new KubeClient();
  const podName = `sandbox-${sandboxId}`;
  const usedPrebuild = Boolean(options.workspaceId && options.prebuildReady);
  const image = resolveSandboxImage({
    workspaceId: options.workspaceId,
    prebuildReady: usedPrebuild,
    baseImage: options.baseImage,
  });

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
    await Promise.all([
      kube.createResource(
        buildSandboxPod({
          sandboxId,
          image,
          opencodePassword,
          workspaceId: options.workspaceId,
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
      kube.createResource(buildSandboxService(sandboxId)),
      kube.createResource(
        buildSandboxIngress(sandboxId, config.domain.baseDomain),
      ),
    ]);

    const podReady = await kube.waitForPodReady(podName, { timeout: 120000 });
    if (!podReady) {
      throw new Error(`Sandbox pod ${podName} did not become ready`);
    }

    const podIp = await waitForPodIp(kube, podName, 60000);
    if (podIp) {
      sandbox.runtime.ipAddress = podIp;
    }

    const agentReady = await ports.agent.waitForAgent(sandboxId, {
      timeout: 60000,
    });
    if (!agentReady) {
      log.warn({ sandboxId }, "Agent did not become ready");
    }

    return { sandbox, podName, usedPrebuild };
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
  const kube = new KubeClient();
  const podName = `sandbox-${sandboxId}`;

  const workspace = sandbox.workspaceId
    ? ports.workspaces.getById(sandbox.workspaceId)
    : undefined;
  const hasPrebuild = workspace?.config.prebuild?.status === "ready";
  const image = resolveSandboxImage({
    workspaceId: sandbox.workspaceId,
    prebuildReady: hasPrebuild,
    baseImage: workspace?.config.baseImage,
  });
  const opencodePassword =
    sandbox.runtime.opencodePassword ?? generatePassword(32);

  try {
    await kube.deleteResource("Pod", podName);
  } catch {}

  await kube.createResource(
    buildSandboxPod({
      sandboxId,
      image,
      opencodePassword,
      workspaceId: sandbox.workspaceId,
      requests: {
        cpu: `${Math.max(250, sandbox.runtime.vcpus * 250)}m`,
        memory: `${sandbox.runtime.memoryMb}Mi`,
      },
      limits: {
        cpu: `${sandbox.runtime.vcpus * 1000}m`,
        memory: `${sandbox.runtime.memoryMb}Mi`,
      },
    }),
  );

  const podReady = await kube.waitForPodReady(podName, { timeout: 120000 });
  if (!podReady) {
    throw new Error(`Sandbox pod ${podName} did not become ready`);
  }

  const podIp = await waitForPodIp(kube, podName, 60000);
  if (podIp) {
    sandbox.runtime.ipAddress = podIp;
  }

  const agentReady = await ports.agent.waitForAgent(sandboxId, {
    timeout: 60000,
  });
  if (!agentReady) {
    log.warn({ sandboxId }, "Agent did not become ready after restart");
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

function resolveSandboxImage(options: {
  workspaceId?: string;
  prebuildReady: boolean;
  baseImage?: string;
}): string {
  if (options.workspaceId && options.prebuildReady) {
    return `${REGISTRY_URL}/workspace-${options.workspaceId}:latest`;
  }

  return `${REGISTRY_URL}/${options.baseImage ?? DEFAULT_BASE_IMAGE}:latest`;
}

function buildUrls(
  sandboxId: string,
  system?: boolean,
): { vscode: string; opencode: string; ssh: string } {
  const baseDomain = config.domain.baseDomain;

  return {
    vscode: system ? "" : `https://sandbox-${sandboxId}.${baseDomain}`,
    opencode: `https://opencode-${sandboxId}.${baseDomain}`,
    ssh: "",
  };
}
