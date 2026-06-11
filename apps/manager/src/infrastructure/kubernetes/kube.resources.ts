import { VM } from "@frak/atelier-shared/constants";
import { config } from "../../shared/lib/config.ts";

export type KubeResource = {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec?: unknown;
  [key: string]: unknown;
};

type ResourceSpec = {
  cpu: string;
  memory: string;
};

export type SandboxPodOptions = {
  sandboxId: string;
  image: string;
  opencodePassword: string;
  workspaceId?: string;
  namespace?: string;
  pvcName?: string;
  configMapName?: string;
  requests?: Partial<ResourceSpec>;
  limits?: Partial<ResourceSpec>;
  devPorts?: Array<number>;
  sshPipeKeySecret?: string;
};

export type IngressOptions = {
  namespace?: string;
  ingressClassName?: string;
  annotations?: Record<string, string>;
  tlsSecretName?: string;
};

/**
 * Sanitize a string for use as a K8s label value.
 * Labels must start/end with alphanumeric and contain only [a-zA-Z0-9._-].
 */
function sanitizeLabelValue(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .replace(/^[^a-zA-Z0-9]+/, "")
    .replace(/[^a-zA-Z0-9]+$/, "")
    .slice(0, 63);
}

function sandboxLabels(sandboxId: string, workspaceId?: string) {
  const labels: Record<string, string> = {
    "atelier.dev/component": "sandbox",
    "atelier.dev/sandbox": sandboxId,
  };

  if (workspaceId) {
    labels["atelier.dev/workspace"] = sanitizeLabelValue(workspaceId);
  }

  return labels;
}

// Single source for the named ports both the pod and service expose, so a
// config.ports override can't make them disagree (agent/ssh are infra ports).
const SANDBOX_PORTS: ReadonlyArray<{ name: string; port: number }> = [
  { name: "agent", port: config.ports.agent },
  { name: "vscode", port: config.ports.vscode },
  { name: "opencode", port: config.ports.opencode },
  { name: "browser", port: config.ports.browser },
  { name: "terminal", port: config.ports.terminal },
  { name: "ssh", port: 22 },
];

const SANDBOX_PORT_NUMBERS = new Set(SANDBOX_PORTS.map((p) => p.port));

export function buildSandboxPod(options: SandboxPodOptions): KubeResource {
  const namespace = options.namespace ?? config.kubernetes.namespace;
  const labels = sandboxLabels(options.sandboxId, options.workspaceId);

  const volumeMounts: Array<Record<string, unknown>> = [];
  const volumes: Array<Record<string, unknown>> = [];

  if (options.pvcName) {
    volumeMounts.push({
      name: "workspace",
      mountPath: VM.HOME,
    });
    volumes.push({
      name: "workspace",
      persistentVolumeClaim: { claimName: options.pvcName },
    });
  }

  if (options.configMapName) {
    volumeMounts.push({
      name: "sandbox-config",
      mountPath: "/etc/sandbox/config.json",
      subPath: "config.json",
      readOnly: true,
    });
    volumes.push({
      name: "sandbox-config",
      configMap: { name: options.configMapName },
    });
  }

  volumeMounts.push({
    name: "shared-binaries",
    mountPath: SHARED_BINARIES_MOUNT_PATH,
    readOnly: true,
  });
  volumes.push({
    name: "shared-binaries",
    persistentVolumeClaim: {
      claimName: "shared-binaries",
      readOnly: true,
    },
  });

  if (options.sshPipeKeySecret) {
    volumeMounts.push({
      name: "ssh-pipe-key",
      mountPath: "/etc/sandbox/ssh",
      readOnly: true,
    });
    volumes.push({
      name: "ssh-pipe-key",
      secret: {
        secretName: options.sshPipeKeySecret,
        items: [{ key: "ssh-publickey", path: "authorized_keys" }],
        defaultMode: 0o644,
      },
    });
  }

  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: `sandbox-${options.sandboxId}`,
      namespace,
      labels,
    },
    spec: {
      runtimeClassName: config.kubernetes.runtimeClass,
      hostname: options.sandboxId.slice(0, 8),
      terminationGracePeriodSeconds: 5,
      containers: [
        {
          name: "sandbox",
          image: options.image,
          // `:latest` would default to imagePullPolicy: Always — a registry
          // round-trip on every spawn. Pull only when not cached on the node.
          imagePullPolicy: "IfNotPresent",
          command: ["/etc/sandbox/sandbox-boot.sh"],
          securityContext: { runAsUser: 0 },
          ports: [
            ...SANDBOX_PORTS.map((p) => ({
              name: p.name,
              containerPort: p.port,
            })),
            ...(options.devPorts ?? [])
              .filter((p) => !SANDBOX_PORT_NUMBERS.has(p))
              .map((p) => ({
                name: `dp-${p}`,
                containerPort: p,
              })),
          ],
          env: [
            { name: "SANDBOX_ID", value: options.sandboxId },
            {
              name: "OPENCODE_PASSWORD",
              value: options.opencodePassword,
            },
          ],
          resources: {
            requests: {
              cpu: options.requests?.cpu ?? "500m",
              memory: options.requests?.memory ?? "1Gi",
            },
            limits: {
              cpu: options.limits?.cpu ?? "1000m",
              memory: options.limits?.memory ?? "2Gi",
            },
          },
          ...(volumeMounts.length > 0 && { volumeMounts }),
        },
      ],
      ...(volumes.length > 0 && { volumes }),
    },
  };
}

export function buildSandboxService(
  sandboxId: string,
  options: {
    devPorts?: Array<{ name: string; port: number }>;
    namespace?: string;
  } = {},
): KubeResource {
  const namespace = options.namespace ?? config.kubernetes.namespace;
  const basePorts = SANDBOX_PORTS.map((p) => ({
    name: p.name,
    port: p.port,
    targetPort: p.port,
  }));

  const extraPorts = (options.devPorts ?? [])
    .filter((dp) => !SANDBOX_PORT_NUMBERS.has(dp.port))
    .map((dp) => ({ name: dp.name, port: dp.port, targetPort: dp.port }));

  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name: `sandbox-${sandboxId}`,
      namespace,
      labels: sandboxLabels(sandboxId),
    },
    spec: {
      type: "ClusterIP",
      selector: {
        "atelier.dev/sandbox": sandboxId,
        "atelier.dev/component": "sandbox",
      },
      ports: [...basePorts, ...extraPorts],
    },
  };
}

export type ToolIngressOptions = {
  sandboxId: string;
  subdomain: string;
  port: number;
  sandboxDomain: string;
  namespace?: string;
  ingressClassName?: string;
  annotations?: Record<string, string>;
  tlsSecretName?: string;
};

export function toolHost(
  subdomain: string,
  sandboxId: string,
  sandboxDomain: string,
): string {
  return `${subdomain}-${sandboxId}.${sandboxDomain}`;
}

export function toolIngressName(subdomain: string, sandboxId: string): string {
  return `sandbox-${subdomain}-${sandboxId}`;
}

export function buildToolIngress(options: ToolIngressOptions): KubeResource {
  const namespace = options.namespace ?? config.kubernetes.namespace;
  const host = toolHost(
    options.subdomain,
    options.sandboxId,
    options.sandboxDomain,
  );

  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "Ingress",
    metadata: {
      name: toolIngressName(options.subdomain, options.sandboxId),
      namespace,
      labels: sandboxLabels(options.sandboxId),
      annotations: options.annotations,
    },
    spec: {
      ingressClassName: options.ingressClassName,
      ...(options.tlsSecretName && {
        tls: [{ secretName: options.tlsSecretName, hosts: [host] }],
      }),
      rules: [
        {
          host,
          http: {
            paths: [
              {
                path: "/",
                pathType: "Prefix",
                backend: {
                  service: {
                    name: `sandbox-${options.sandboxId}`,
                    port: { number: options.port },
                  },
                },
              },
            ],
          },
        },
      ],
    },
  };
}

export function buildDevCommandIngress(
  sandboxId: string,
  name: string,
  port: number,
  sandboxDomain: string,
  options: IngressOptions = {},
): KubeResource {
  const namespace = options.namespace ?? config.kubernetes.namespace;
  const host = `dev-${name}-${sandboxId}.${sandboxDomain}`;

  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "Ingress",
    metadata: {
      name: `dev-${name}-${sandboxId}`,
      namespace,
      labels: sandboxLabels(sandboxId),
      annotations: options.annotations,
    },
    spec: {
      ingressClassName: options.ingressClassName,
      ...(options.tlsSecretName && {
        tls: [{ secretName: options.tlsSecretName, hosts: [host] }],
      }),
      rules: [
        {
          host,
          http: {
            paths: [
              {
                path: "/",
                pathType: "Prefix",
                backend: {
                  service: {
                    name: `sandbox-${sandboxId}`,
                    port: { number: port },
                  },
                },
              },
            ],
          },
        },
      ],
    },
  };
}

export function buildDefaultDevIngress(
  sandboxId: string,
  port: number,
  sandboxDomain: string,
  options: IngressOptions = {},
): KubeResource {
  const namespace = options.namespace ?? config.kubernetes.namespace;
  const host = `dev-${sandboxId}.${sandboxDomain}`;

  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "Ingress",
    metadata: {
      name: `dev-default-${sandboxId}`,
      namespace,
      labels: sandboxLabels(sandboxId),
      annotations: options.annotations,
    },
    spec: {
      ingressClassName: options.ingressClassName,
      ...(options.tlsSecretName && {
        tls: [{ secretName: options.tlsSecretName, hosts: [host] }],
      }),
      rules: [
        {
          host,
          http: {
            paths: [
              {
                path: "/",
                pathType: "Prefix",
                backend: {
                  service: {
                    name: `sandbox-${sandboxId}`,
                    port: { number: port },
                  },
                },
              },
            ],
          },
        },
      ],
    },
  };
}

export function buildConfigMap(
  name: string,
  data: Record<string, string>,
  namespace = config.kubernetes.namespace,
  labels: Record<string, string> = {},
): KubeResource {
  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name,
      namespace,
      labels: {
        "atelier.dev/sandbox": labels["atelier.dev/sandbox"] ?? "system",
        ...labels,
      },
    },
    data,
  };
}

// ---------------------------------------------------------------------------
// PVC & VolumeSnapshot builders
// ---------------------------------------------------------------------------

export type PvcOptions = {
  name: string;
  namespace?: string;
  size: string;
  storageClassName?: string;
  snapshotName?: string;
  labels?: Record<string, string>;
};

export function buildPvc(options: PvcOptions): KubeResource {
  const namespace = options.namespace ?? config.kubernetes.namespace;
  const storageClassName =
    options.storageClassName || config.kubernetes.storageClass || undefined;

  const spec: Record<string, unknown> = {
    accessModes: ["ReadWriteOnce"],
    resources: {
      requests: { storage: options.size },
    },
  };

  if (storageClassName) {
    spec.storageClassName = storageClassName;
  }

  if (options.snapshotName) {
    spec.dataSource = {
      name: options.snapshotName,
      kind: "VolumeSnapshot",
      apiGroup: "snapshot.storage.k8s.io",
    };
  }

  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: {
      name: options.name,
      namespace,
      labels: options.labels,
    },
    spec,
  };
}

export type VolumeSnapshotOptions = {
  name: string;
  namespace?: string;
  pvcName: string;
  volumeSnapshotClassName?: string;
  labels?: Record<string, string>;
};

export function buildVolumeSnapshot(
  options: VolumeSnapshotOptions,
): KubeResource {
  const namespace = options.namespace ?? config.kubernetes.namespace;
  const volumeSnapshotClassName =
    options.volumeSnapshotClassName ||
    config.kubernetes.volumeSnapshotClass ||
    undefined;

  const spec: Record<string, unknown> = {
    source: {
      persistentVolumeClaimName: options.pvcName,
    },
  };

  if (volumeSnapshotClassName) {
    spec.volumeSnapshotClassName = volumeSnapshotClassName;
  }

  return {
    apiVersion: "snapshot.storage.k8s.io/v1",
    kind: "VolumeSnapshot",
    metadata: {
      name: options.name,
      namespace,
      labels: options.labels,
    },
    spec,
  };
}

export type SshPipeOptions = {
  sandboxId: string;
  targetHost: string;
  authorizedKeysData?: string;
  privateKeySecretName?: string;
  namespace?: string;
  workspaceId?: string;
};

export function buildSshPipe(options: SshPipeOptions): KubeResource {
  const namespace = options.namespace ?? config.kubernetes.namespace;
  const labels: Record<string, string> = {
    "atelier.dev/component": "ssh-pipe",
    "atelier.dev/sandbox": options.sandboxId,
  };
  if (options.workspaceId) {
    labels["atelier.dev/workspace"] = sanitizeLabelValue(options.workspaceId);
  }

  return {
    apiVersion: "sshpiper.com/v1beta1",
    kind: "Pipe",
    metadata: {
      name: `ssh-${options.sandboxId}`,
      namespace,
      labels,
      annotations: {
        "sshpiper.com/no_ca_publickey": "true",
      },
    },
    spec: {
      from: [
        {
          username: options.sandboxId,
          ...(options.authorizedKeysData && {
            authorized_keys_data: options.authorizedKeysData,
          }),
        },
      ],
      to: {
        host: `${options.targetHost}:22`,
        username: "dev",
        ignore_hostkey: true,
        ...(options.privateKeySecretName && {
          private_key_secret: { name: options.privateKeySecretName },
        }),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Shared binaries mount path (used by sandbox pod builder)
// ---------------------------------------------------------------------------

const SHARED_BINARIES_MOUNT_PATH = "/opt/shared";

export { SHARED_BINARIES_MOUNT_PATH };

// ---------------------------------------------------------------------------
// Dev port collection helper (used by sandbox boot)
// ---------------------------------------------------------------------------

type DevCommandLike = {
  name: string;
  port?: number;
  extraPorts?: Array<{ port: number; alias: string }>;
};

export function collectDevPorts(
  devCommands?: DevCommandLike[],
): Array<{ name: string; port: number }> {
  if (!devCommands?.length) return [];
  const seen = new Set<number>();
  const ports: Array<{ name: string; port: number }> = [];
  for (const cmd of devCommands) {
    if (cmd.port && !seen.has(cmd.port)) {
      seen.add(cmd.port);
      ports.push({ name: `dp-${cmd.port}`, port: cmd.port });
    }
    for (const ep of cmd.extraPorts ?? []) {
      if (!seen.has(ep.port)) {
        seen.add(ep.port);
        ports.push({ name: `dp-${ep.port}`, port: ep.port });
      }
    }
  }
  return ports;
}
