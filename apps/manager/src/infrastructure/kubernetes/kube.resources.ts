import { type SharedBinaryInfo, VM } from "@frak/atelier-shared/constants";
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
};

export type IngressOptions = {
  namespace?: string;
  ingressClassName?: string;
  annotations?: Record<string, string>;
};

export type KanikoJobOptions = {
  name: string;
  namespace?: string;
  contextUrl?: string;
  configMapName?: string;
  destinationImage: string;
  dockerfilePath?: string;
  insecure?: boolean;
  buildArgs?: Record<string, string>;
  labels?: Record<string, string>;
  serviceAccountName?: string;
};

function sandboxLabels(sandboxId: string, workspaceId?: string) {
  const labels: Record<string, string> = {
    "atelier.dev/component": "sandbox",
    "atelier.dev/sandbox": sandboxId,
  };

  if (workspaceId) {
    labels["atelier.dev/workspace"] = workspaceId;
  }

  return labels;
}

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
      mountPath: "/etc/sandbox",
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
          ports: [
            { name: "agent", containerPort: 9998 },
            { name: "vscode", containerPort: 8080 },
            { name: "opencode", containerPort: 3000 },
            { name: "browser", containerPort: 6080 },
            { name: "terminal", containerPort: 7681 },
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
  namespace = config.kubernetes.namespace,
): KubeResource {
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
      ports: [
        { name: "agent", port: 9998, targetPort: 9998 },
        { name: "vscode", port: 8080, targetPort: 8080 },
        { name: "opencode", port: 3000, targetPort: 3000 },
        { name: "browser", port: 6080, targetPort: 6080 },
        { name: "terminal", port: 7681, targetPort: 7681 },
      ],
    },
  };
}

export function buildSandboxIngress(
  sandboxId: string,
  baseDomain: string,
  options: IngressOptions = {},
): KubeResource {
  const namespace = options.namespace ?? config.kubernetes.namespace;

  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "Ingress",
    metadata: {
      name: `sandbox-${sandboxId}`,
      namespace,
      labels: sandboxLabels(sandboxId),
      annotations: options.annotations,
    },
    spec: {
      ingressClassName: options.ingressClassName,
      rules: [
        {
          host: `sandbox-${sandboxId}.${baseDomain}`,
          http: {
            paths: [
              {
                path: "/",
                pathType: "Prefix",
                backend: {
                  service: {
                    name: `sandbox-${sandboxId}`,
                    port: { number: 8080 },
                  },
                },
              },
            ],
          },
        },
        {
          host: `opencode-${sandboxId}.${baseDomain}`,
          http: {
            paths: [
              {
                path: "/",
                pathType: "Prefix",
                backend: {
                  service: {
                    name: `sandbox-${sandboxId}`,
                    port: { number: 3000 },
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
  baseDomain: string,
  namespace = config.kubernetes.namespace,
): KubeResource {
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "Ingress",
    metadata: {
      name: `dev-${name}-${sandboxId}`,
      namespace,
      labels: sandboxLabels(sandboxId),
    },
    spec: {
      rules: [
        {
          host: `dev-${name}-${sandboxId}.${baseDomain}`,
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

export function buildKanikoJob(options: KanikoJobOptions): KubeResource {
  const namespace = options.namespace ?? config.kubernetes.systemNamespace;
  if (!options.configMapName && !options.contextUrl) {
    throw new Error("Kaniko job requires contextUrl or configMapName");
  }

  const contextArg = options.configMapName
    ? "--context=dir:///kaniko/context"
    : `--context=${options.contextUrl}`;

  const cacheRepo = `${config.kubernetes.registryUrl}/cache`;
  const args = [
    contextArg,
    `--dockerfile=${options.dockerfilePath ?? "Dockerfile"}`,
    `--destination=${options.destinationImage}`,
    "--cache=true",
    `--cache-repo=${cacheRepo}`,
  ];

  if (options.insecure) {
    args.push("--insecure", "--insecure-pull", "--cache-copy-layers");
  }

  for (const [key, value] of Object.entries(options.buildArgs ?? {})) {
    args.push(`--build-arg ${key}=${value}`);
  }

  const volumeMounts = options.configMapName
    ? [
        {
          name: "context",
          mountPath: "/kaniko/context",
        },
      ]
    : undefined;

  const volumes = options.configMapName
    ? [
        {
          name: "context",
          configMap: { name: options.configMapName },
        },
      ]
    : undefined;

  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: options.name,
      namespace,
      labels: {
        "atelier.dev/sandbox":
          options.labels?.["atelier.dev/sandbox"] ?? "system",
        ...options.labels,
      },
    },
    spec: {
      backoffLimit: 1,
      template: {
        metadata: {
          labels: options.labels,
        },
        spec: {
          restartPolicy: "Never",
          serviceAccountName: options.serviceAccountName,
          containers: [
            {
              name: "kaniko",
              image: "gcr.io/kaniko-project/executor:latest",
              args,
              volumeMounts,
            },
          ],
          volumes,
        },
      },
    },
  };
}

export type BaseImageBuildJobOptions = {
  name: string;
  imageId: string;
  configMapName: string;
  configMapItems?: Array<{ key: string; path: string }>;
  destinationImage: string;
  namespace?: string;
  buildArgs?: Record<string, string>;
};

export function buildBaseImageBuildJob(
  options: BaseImageBuildJobOptions,
): KubeResource {
  const namespace = options.namespace ?? config.kubernetes.systemNamespace;

  const cacheRepo = `${config.kubernetes.registryUrl}/cache`;
  const args = [
    "--context=dir:///workspace",
    "--dockerfile=Dockerfile",
    `--destination=${options.destinationImage}`,
    "--insecure",
    "--insecure-pull",
    "--cache=true",
    `--cache-repo=${cacheRepo}`,
    "--cache-copy-layers",
  ];

  for (const [key, value] of Object.entries(options.buildArgs ?? {})) {
    args.push(`--build-arg=${key}=${value}`);
  }

  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: options.name,
      namespace,
      labels: {
        "atelier.dev/component": "base-image-build",
        "atelier.dev/image": options.imageId,
      },
    },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 3600,
      template: {
        metadata: {
          labels: {
            "atelier.dev/component": "base-image-build",
            "atelier.dev/image": options.imageId,
          },
        },
        spec: {
          restartPolicy: "Never",
          initContainers: [
            {
              name: "prepare-context",
              image: "busybox:1.37",
              command: ["sh", "-c", "cp -rL /config/* /workspace/"],
              volumeMounts: [
                {
                  name: "config",
                  mountPath: "/config",
                  readOnly: true,
                },
                {
                  name: "workspace",
                  mountPath: "/workspace",
                },
              ],
            },
          ],
          containers: [
            {
              name: "kaniko",
              image: "gcr.io/kaniko-project/executor:latest",
              args,
              volumeMounts: [
                {
                  name: "workspace",
                  mountPath: "/workspace",
                },
              ],
            },
          ],
          volumes: [
            {
              name: "config",
              configMap: {
                name: options.configMapName,
                items: options.configMapItems,
              },
            },
            {
              name: "workspace",
              emptyDir: {},
            },
          ],
        },
      },
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

// ---------------------------------------------------------------------------
// Shared binaries PV / PVC / updater Job
// ---------------------------------------------------------------------------

const SHARED_BINARIES_LABELS: Record<string, string> = {
  "atelier.dev/component": "shared-binaries",
};

const SHARED_BINARIES_MOUNT_PATH = "/opt/shared";

export function buildSharedBinariesPv(
  name: string,
  namespace: string,
): KubeResource {
  return {
    apiVersion: "v1",
    kind: "PersistentVolume",
    metadata: {
      name,
      labels: SHARED_BINARIES_LABELS,
    },
    spec: {
      capacity: { storage: "2Gi" },
      accessModes: ["ReadWriteOnce", "ReadOnlyMany"],
      persistentVolumeReclaimPolicy: "Retain",
      storageClassName: "",
      claimRef: {
        namespace,
        name,
      },
      local: { path: "/opt/atelier/shared-binaries" },
      nodeAffinity: {
        required: {
          nodeSelectorTerms: [
            {
              matchExpressions: [
                {
                  key: "kubernetes.io/hostname",
                  operator: "Exists",
                },
              ],
            },
          ],
        },
      },
    },
  };
}

export function buildSharedBinariesPvc(
  name: string,
  namespace: string,
): KubeResource {
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: {
      name,
      namespace,
      labels: SHARED_BINARIES_LABELS,
    },
    spec: {
      storageClassName: "",
      accessModes: ["ReadWriteOnce", "ReadOnlyMany"],
      resources: { requests: { storage: "2Gi" } },
      volumeName: name,
    },
  };
}

export type SharedBinariesJobOptions = {
  name: string;
  namespace: string;
  pvcName: string;
  binaries: SharedBinaryInfo[];
};

/**
 * Build an updater Job that downloads + extracts shared binaries into the PVC.
 * Each binary gets its own init container that downloads & extracts, then the
 * main container sets up the final `/shared/bin` symlink directory.
 */
export function buildSharedBinariesJob(
  options: SharedBinariesJobOptions,
): KubeResource {
  // Build a shell script that downloads & extracts each binary,
  // then creates a unified /shared/bin directory with symlinks.
  const steps = options.binaries.map((bin) => {
    const dir = `/shared/${bin.name}`;
    return [
      `echo "[shared-binaries] Installing ${bin.name} v${bin.version}"`,
      `mkdir -p ${dir}`,
      `cd /tmp`,
      `curl -fsSL -o archive-${bin.name} "${bin.url}"`,
      `${bin.extractCommand} archive-${bin.name} -C ${dir} --strip-components=1`,
      `rm -f archive-${bin.name}`,
    ].join(" && ");
  });

  // After all binaries are extracted, create /shared/bin with symlinks
  // so PATH only needs one entry.
  const symlinkLines = options.binaries.map((bin) => {
    const target = `/shared/${bin.name}/${bin.binaryPath}`;
    return `[ -f "${target}" ] && ln -sf "${target}" /shared/bin/${bin.name}`;
  });

  // code-server also has a bin/ wrapper
  const codeServerBin = "/shared/code-server/bin/code-server";
  symlinkLines.push(
    `[ -f "${codeServerBin}" ] && ln -sf "${codeServerBin}" /shared/bin/code-server`,
  );

  const script = [
    "set -e",
    ...steps,
    "mkdir -p /shared/bin",
    ...symlinkLines,
    'echo "[shared-binaries] Done"',
  ].join("\n");

  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: options.name,
      namespace: options.namespace,
      labels: SHARED_BINARIES_LABELS,
    },
    spec: {
      backoffLimit: 2,
      ttlSecondsAfterFinished: 300,
      template: {
        metadata: { labels: SHARED_BINARIES_LABELS },
        spec: {
          securityContext: { runAsUser: 0 },
          restartPolicy: "Never",
          containers: [
            {
              name: "updater",
              image: "curlimages/curl:latest",
              command: ["/bin/sh", "-c", script],
              volumeMounts: [
                {
                  name: "shared-binaries",
                  mountPath: "/shared",
                },
              ],
            },
          ],
          volumes: [
            {
              name: "shared-binaries",
              persistentVolumeClaim: {
                claimName: options.pvcName,
              },
            },
          ],
        },
      },
    },
  };
}

export { SHARED_BINARIES_LABELS, SHARED_BINARIES_MOUNT_PATH };
