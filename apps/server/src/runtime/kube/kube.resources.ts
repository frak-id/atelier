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
  agentPassword: string;
  workspaceId?: string;
  namespace?: string;
  pvcName?: string;
  requests?: Partial<ResourceSpec>;
  limits?: Partial<ResourceSpec>;
  sshPipeKeySecret?: string;
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

// Infra ports only — the single source both the pod and Service expose
// unconditionally. Every tool port (vscode, web UIs, dev servers…) is
// toolbox/spec-declared and rides `spec.ports` into
// `buildSandboxService(options.ports)` / `buildPortIngresses`. Keeping tool
// ports out of this list matters beyond genericity: a stale static entry
// here claims the port *name* in the Service dedup below and silently
// shadows the spec's real entry (this happened with opencode — static 3000
// masked the harness's declared 4096, so its ingress had no backend).
const SANDBOX_PORTS: ReadonlyArray<{ name: string; port: number }> = [
  { name: "agent", port: config.ports.agent },
  { name: "ssh", port: 22 },
];

export function buildSandboxPod(options: SandboxPodOptions): KubeResource {
  const namespace = options.namespace ?? config.kubernetes.namespace;
  const labels = sandboxLabels(options.sandboxId, options.workspaceId);

  const volumeMounts: Array<Record<string, unknown>> = [];
  const volumes: Array<Record<string, unknown>> = [];

  if (options.pvcName) {
    // PVC mounts at VM.DATA, not VM.HOME (toolset-overlay-squashfs.md §3):
    // the guest entrypoint assembles an overlay at HOME from `/home/skel`
    // (image lower) + toolset squashfs blobs (pulled to DATA_TOOLSETS) as
    // read-only lowers, with DATA_UPPER/DATA_WORK as the writable upper.
    volumeMounts.push({
      name: "workspace",
      mountPath: VM.DATA,
    });
    volumes.push({
      name: "workspace",
      persistentVolumeClaim: { claimName: options.pvcName },
    });
  }

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
          // runAsUser 0 + CAP_SYS_ADMIN: the agent loop-mounts squashfs
          // toolset blobs and assembles the /home/dev overlay from INSIDE the
          // container (toolset-overlay-squashfs.md §3). uid 0 alone gets the
          // default OCI capability set, which excludes CAP_SYS_ADMIN, so
          // mount(2) would EPERM. Cheap under Kata: the VM (not the container
          // capset) is the isolation boundary. Pre-cutover, verify in a booted
          // sandbox: `capsh --print` shows cap_sys_admin, and `mount -t
          // squashfs -o ro,loop <blob> /mnt` succeeds.
          securityContext: {
            runAsUser: 0,
            capabilities: { add: ["SYS_ADMIN"] },
          },
          ports: SANDBOX_PORTS.map((p) => ({
            name: p.name,
            containerPort: p.port,
          })),
          env: [
            { name: "SANDBOX_ID", value: options.sandboxId },
            {
              // Pod-level agent Basic-auth password. NOTE: if the pod image's
              // boot script still reads $OPENCODE_PASSWORD, update it there too.
              name: "AGENT_PASSWORD",
              value: options.agentPassword,
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
    namespace?: string;
    ports?: ReadonlyArray<{ name: string; port: number }>;
  } = {},
): KubeResource {
  const namespace = options.namespace ?? config.kubernetes.namespace;
  // Base infra ports (agent/ssh/well-known tools) plus any ports the spec's
  // toolboxes declare. Without the latter, a toolbox port (e.g. pi-web's) gets
  // an ingress pointing at `service:<port>` but no matching Service port, so
  // Traefik has no backend and returns 404. Dedupe by name and port number
  // (k8s requires unique Service port names).
  const byName = new Set<string>();
  const byPort = new Set<number>();
  const ports: { name: string; port: number; targetPort: number }[] = [];
  for (const p of [...SANDBOX_PORTS, ...(options.ports ?? [])]) {
    if (byName.has(p.name) || byPort.has(p.port)) continue;
    byName.add(p.name);
    byPort.add(p.port);
    ports.push({ name: p.name, port: p.port, targetPort: p.port });
  }

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
      ports,
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
  annotations?: Record<string, string>;
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
      annotations: options.annotations,
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
