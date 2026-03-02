import { REGISTRY } from "@frak/atelier-shared/constants";
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
        },
      ],
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

  const args = [
    contextArg,
    `--dockerfile=${options.dockerfilePath ?? "Dockerfile"}`,
    `--destination=${options.destinationImage}`,
  ];

  if (options.insecure) {
    args.push("--insecure");
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

export function buildVerdaccioPod(
  namespace = config.kubernetes.systemNamespace,
): KubeResource {
  const port = config.advanced.server.verdaccio.port;
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: "verdaccio",
      namespace,
      labels: {
        "atelier.dev/component": "registry",
        "atelier.dev/service": "verdaccio",
      },
    },
    spec: {
      containers: [
        {
          name: "verdaccio",
          image: config.kubernetes.verdaccioImage,
          ports: [{ name: "http", containerPort: port }],
          volumeMounts: [
            {
              name: "config",
              mountPath: "/verdaccio/conf",
            },
            {
              name: "storage",
              mountPath: "/verdaccio/storage",
            },
          ],
          readinessProbe: {
            httpGet: { path: "/-/ping", port },
            initialDelaySeconds: 5,
            periodSeconds: 10,
          },
          livenessProbe: {
            httpGet: { path: "/-/ping", port },
            initialDelaySeconds: 15,
            periodSeconds: 30,
          },
        },
      ],
      volumes: [
        {
          name: "config",
          configMap: { name: "verdaccio-config" },
        },
        {
          name: "storage",
          hostPath: {
            path: REGISTRY.STORAGE_DIR,
            type: "DirectoryOrCreate",
          },
        },
      ],
    },
  };
}

export function buildVerdaccioService(
  namespace = config.kubernetes.systemNamespace,
): KubeResource {
  const port = config.advanced.server.verdaccio.port;
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name: "verdaccio",
      namespace,
      labels: {
        "atelier.dev/component": "registry",
        "atelier.dev/service": "verdaccio",
      },
    },
    spec: {
      type: "ClusterIP",
      selector: {
        "atelier.dev/component": "registry",
        "atelier.dev/service": "verdaccio",
      },
      ports: [{ name: "http", port, targetPort: port }],
    },
  };
}
