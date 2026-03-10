import { Buffer } from "node:buffer";
import { generateKeyPairSync } from "node:crypto";
import { customAlphabet } from "nanoid";
import { eventBus } from "../../infrastructure/events/index.ts";
import {
  buildConfigMap,
  buildOpenCodeIngress,
  buildPvc,
  buildSandboxPod,
  buildSandboxService,
  buildSshPipe,
  buildSshPipeKeySecret,
  buildVsCodeIngress,
  collectDevPorts,
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

    const devPorts = collectDevPorts(options.workspace?.config.devCommands);
    const devPortNumbers = devPorts.map((dp) => dp.port);

    const pipeKeyPair = generateSshPipeKeyPair();
    const pipeKeySecretName = `ssh-pipe-key-${sandboxId}`;

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
                [pipeKeyPair.publicKeySsh],
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
          devPorts: devPortNumbers,
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
      kubeClient.createResource(buildSandboxService(sandboxId, { devPorts })),
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
      kubeClient.createResource(
        buildSshPipeKeySecret(sandboxId, pipeKeyPair.privateKeyPem),
      ),
      kubeClient.createResource(
        buildSshPipe({
          sandboxId,
          targetHost: `sandbox-${sandboxId}.${config.kubernetes.namespace}.svc`,
          authorizedKeysData: encodeSshAuthorizedKeys(
            ports.sshKeys.getValidPublicKeys(),
          ),
          privateKeySecretName: pipeKeySecretName,
          workspaceId: options.workspaceId,
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

  const devPorts = collectDevPorts(workspace?.config.devCommands);
  const devPortNumbers = devPorts.map((dp) => dp.port);

  try {
    await kubeClient.deleteResource("Pod", podName);
  } catch {}
  try {
    await kubeClient.deleteResource("ConfigMap", configMapName);
  } catch {}
  try {
    await kubeClient.deleteResource("Service", `sandbox-${sandboxId}`);
  } catch {}
  try {
    await kubeClient.deleteResource("Ingress", `sandbox-vscode-${sandboxId}`);
  } catch {}
  try {
    await kubeClient.deleteResource("Ingress", `sandbox-opencode-${sandboxId}`);
  } catch {}
  try {
    await kubeClient.deleteResource("Pipe", `ssh-${sandboxId}`);
  } catch {}
  try {
    await kubeClient.deleteResource("Secret", `ssh-pipe-key-${sandboxId}`);
  } catch {}

  const pipeKeyPair = generateSshPipeKeyPair();
  const pipeKeySecretName = `ssh-pipe-key-${sandboxId}`;

  const sandboxConfig = buildSandboxConfig(
    sandboxId,
    workspace,
    opencodePassword,
    [pipeKeyPair.publicKeySsh],
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
        devPorts: devPortNumbers,
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
    kubeClient.createResource(buildSandboxService(sandboxId, { devPorts })),
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
    kubeClient.createResource(
      buildSshPipeKeySecret(sandboxId, pipeKeyPair.privateKeyPem),
    ),
    kubeClient.createResource(
      buildSshPipe({
        sandboxId,
        targetHost: `sandbox-${sandboxId}.${config.kubernetes.namespace}.svc`,
        authorizedKeysData: encodeSshAuthorizedKeys(
          ports.sshKeys.getValidPublicKeys(),
        ),
        privateKeySecretName: pipeKeySecretName,
        workspaceId: sandbox.workspaceId,
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
  const sshHost =
    config.domain.ssh.hostname || `ssh.${config.domain.baseDomain}`;
  const sshPort = config.domain.ssh.port;

  return {
    vscode: system ? "" : `https://vscode-${sandboxId}.${sandboxDomain}`,
    opencode: `https://opencode-${sandboxId}.${sandboxDomain}`,
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

function generateSshPipeKeyPair(): {
  privateKeyPem: string;
  publicKeySsh: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({
    type: "pkcs8",
    format: "pem",
  }) as string;

  const publicKeyDer = publicKey.export({
    type: "spki",
    format: "der",
  }) as Buffer;
  const rawPubKey = publicKeyDer.subarray(publicKeyDer.length - 32);

  const keyTypeStr = "ssh-ed25519";
  const keyTypeBytes = Buffer.from(keyTypeStr);
  const blob = Buffer.alloc(4 + keyTypeBytes.length + 4 + rawPubKey.length);
  blob.writeUInt32BE(keyTypeBytes.length, 0);
  keyTypeBytes.copy(blob, 4);
  blob.writeUInt32BE(rawPubKey.length, 4 + keyTypeBytes.length);
  rawPubKey.copy(blob, 4 + keyTypeBytes.length + 4);

  const publicKeySsh = `ssh-ed25519 ${blob.toString("base64")} sshpiper`;
  return { privateKeyPem, publicKeySsh };
}
