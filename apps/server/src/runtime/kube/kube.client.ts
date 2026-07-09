import { Buffer } from "node:buffer";
import { SandboxError } from "../../shared/errors.ts";
import { config, isMock } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import type { KubeResource } from "./kube.resources.ts";

const log = createChildLogger("kube-client");

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 200;

type KubeClientConfig = {
  kubeconfig?: string;
  namespace?: string;
};

type KubeAuthConfig = {
  server: string;
  token?: string;
  tls?: {
    ca?: string;
    cert?: string;
    key?: string;
  };
};

type BunRequestInit = RequestInit & {
  tls?: {
    ca?: string;
    cert?: string;
    key?: string;
  };
};

type KubeStatusResponse = {
  status?: {
    podIP?: string;
  };
};

export class KubeApiError extends SandboxError {
  constructor(
    message: string,
    public status: number,
    public reason?: string,
  ) {
    super(message, "KUBE_API_ERROR", status);
    this.name = "KubeApiError";
  }
}

export class KubeClient {
  public readonly namespace: string;
  private readonly kubeconfigPath: string;
  private authConfigPromise?: Promise<KubeAuthConfig>;

  constructor(options: KubeClientConfig = {}) {
    this.namespace = options.namespace ?? config.kubernetes.namespace;
    this.kubeconfigPath = options.kubeconfig ?? config.kubernetes.kubeconfig;
  }

  async get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: "GET" });
  }

  async list<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: "GET" });
  }

  async create<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: "POST", body });
  }

  async delete(path: string): Promise<void> {
    await this.request(path, { method: "DELETE" });
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: "PATCH",
      body,
      headers: {
        "Content-Type": "application/strategic-merge-patch+json",
      },
    });
  }

  async createResource(
    resource: KubeResource,
    namespace = this.namespace,
  ): Promise<KubeResource> {
    if (isMock()) {
      return resource;
    }

    const path = resourceCollectionPath(resource.kind, namespace);
    return this.create<KubeResource>(path, resource);
  }

  async deleteResource(
    kind: string,
    name: string,
    namespace = this.namespace,
  ): Promise<void> {
    if (isMock()) {
      return;
    }

    const path = resourceItemPath(kind, name, namespace);
    await this.delete(path);
  }

  async deleteLabeledResources(
    labelSelector: string,
    namespace = this.namespace,
  ): Promise<void> {
    if (isMock()) {
      return;
    }

    const selector = encodeURIComponent(labelSelector);
    const collections = [
      { path: "pods", api: "core" },
      { path: "services", api: "core" },
      { path: "configmaps", api: "core" },
      {
        path: "persistentvolumeclaims",
        api: "core",
      },
      { path: "secrets", api: "core" },
      { path: "ingresses", api: "networking" },
      {
        path: "volumesnapshots",
        api: "snapshot",
      },
      {
        path: "pipes",
        api: "sshpiper",
      },
    ] as const;

    for (const col of collections) {
      let base: string;
      if (col.api === "networking") {
        base = `/apis/networking.k8s.io/v1/namespaces/${namespace}/${col.path}`;
      } else if (col.api === "snapshot") {
        base = `/apis/snapshot.storage.k8s.io/v1/namespaces/${namespace}/${col.path}`;
      } else if (col.api === "sshpiper") {
        base = `/apis/sshpiper.com/v1beta1/namespaces/${namespace}/${col.path}`;
      } else {
        base = `/api/v1/namespaces/${namespace}/${col.path}`;
      }

      try {
        const list = await this.list<{
          items?: Array<{ metadata?: { name?: string } }>;
        }>(`${base}?labelSelector=${selector}`);

        const items = list.items ?? [];
        for (const item of items) {
          const name = item.metadata?.name;
          if (!name) continue;
          await this.delete(`${base}/${name}`);
        }
      } catch {
        // VolumeSnapshot CRD may not be installed — skip
      }
    }
  }

  async deleteLabeledIngresses(
    labelSelector: string,
    namespace = this.namespace,
  ): Promise<void> {
    if (isMock()) {
      return;
    }

    const selector = encodeURIComponent(labelSelector);
    const base = `/apis/networking.k8s.io/v1/namespaces/${namespace}/ingresses`;
    const list = await this.list<{
      items?: Array<{ metadata?: { name?: string } }>;
    }>(`${base}?labelSelector=${selector}`);

    for (const item of list.items ?? []) {
      const name = item.metadata?.name;
      // Per-item catch so one stale entry (e.g. a concurrent destroy 404)
      // doesn't abort the sweep and leak the remaining ingresses.
      if (name) await this.delete(`${base}/${name}`).catch(() => {});
    }
  }

  async getPodIp(
    name: string,
    namespace = this.namespace,
  ): Promise<string | null> {
    if (isMock()) {
      return "10.42.0.99";
    }

    const pod = await this.get<KubeStatusResponse>(
      `/api/v1/namespaces/${namespace}/pods/${name}`,
    );
    return pod.status?.podIP ?? null;
  }

  async waitForVolumeSnapshotReady(
    name: string,
    options: { timeout?: number; namespace?: string } = {},
  ): Promise<boolean> {
    if (isMock()) {
      return true;
    }

    const timeout = options.timeout ?? 120_000;
    const namespace = options.namespace ?? this.namespace;
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeout) {
      const snap = await this.get<{
        status?: { readyToUse?: boolean; error?: { message?: string } };
      }>(
        `/apis/snapshot.storage.k8s.io/v1/namespaces/${namespace}/volumesnapshots/${name}`,
      );
      if (snap.status?.readyToUse === true) return true;
      if (snap.status?.error?.message) return false;
      await Bun.sleep(2000);
    }

    return false;
  }

  async resourceExists(
    kind: string,
    name: string,
    namespace = this.namespace,
  ): Promise<boolean> {
    if (isMock()) return false;
    try {
      const path = resourceItemPath(kind, name, namespace);
      await this.get(path);
      return true;
    } catch {
      return false;
    }
  }

  async waitForResourceDeleted(
    kind: string,
    name: string,
    options: {
      timeout?: number;
      namespace?: string;
      pollIntervalMs?: number;
    } = {},
  ): Promise<boolean> {
    if (isMock()) return true;

    const timeout = options.timeout ?? 60_000;
    const namespace = options.namespace ?? this.namespace;
    const pollInterval = options.pollIntervalMs ?? 1_000;
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeout) {
      if (!(await this.resourceExists(kind, name, namespace))) return true;
      await Bun.sleep(pollInterval);
    }

    return false;
  }

  private async request<T = unknown>(
    path: string,
    options: {
      method: "GET" | "POST" | "DELETE" | "PATCH";
      body?: unknown;
      headers?: Record<string, string>;
    },
  ): Promise<T> {
    if (isMock()) {
      return {} as T;
    }

    const auth = await this.getAuthConfig();
    const url = this.buildUrl(auth.server, path);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const response = await fetch(url, {
        method: options.method,
        headers: this.buildHeaders(auth, options.headers),
        body: options.body ? JSON.stringify(options.body) : undefined,
        tls: auth.tls,
      } as BunRequestInit);

      if (response.ok) {
        const text = await response.text();
        if (!text) {
          return {} as T;
        }

        return JSON.parse(text) as T;
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === MAX_ATTEMPTS) {
        throw await this.toKubeError(response, `Request failed: ${path}`);
      }

      const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
      log.warn(
        { path, status: response.status, attempt, delay },
        "Kubernetes request failed, retrying",
      );
      await Bun.sleep(delay);
    }

    throw new KubeApiError(`Unexpected failure for ${path}`, 500);
  }

  private buildHeaders(
    auth: KubeAuthConfig,
    headers?: Record<string, string>,
  ): Record<string, string> {
    const merged: Record<string, string> = {
      Accept: "application/json",
      ...(headers ?? {}),
    };

    if (auth.token) {
      merged.Authorization = `Bearer ${auth.token}`;
    }

    if (!merged["Content-Type"]) {
      merged["Content-Type"] = "application/json";
    }

    return merged;
  }

  private async getAuthConfig(): Promise<KubeAuthConfig> {
    if (!this.authConfigPromise) {
      this.authConfigPromise = this.loadAuthConfig();
    }
    return this.authConfigPromise;
  }

  private async loadAuthConfig(): Promise<KubeAuthConfig> {
    const inClusterHost = process.env.KUBERNETES_SERVICE_HOST;
    if (inClusterHost) {
      return this.loadInClusterAuth();
    }
    return this.loadKubeconfigAuth();
  }

  private async loadInClusterAuth(): Promise<KubeAuthConfig> {
    const host = process.env.KUBERNETES_SERVICE_HOST;
    const port = process.env.KUBERNETES_SERVICE_PORT ?? "443";

    if (!host) {
      throw new KubeApiError("Missing in-cluster Kubernetes host", 500);
    }

    const token = await Bun.file(
      "/var/run/secrets/kubernetes.io/serviceaccount/token",
    ).text();
    const ca = await Bun.file(
      "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
    ).text();

    return {
      server: `https://${host}:${port}`,
      token: token.trim(),
      tls: { ca },
    };
  }

  private async loadKubeconfigAuth(): Promise<KubeAuthConfig> {
    const content = await Bun.file(this.kubeconfigPath).text();
    const server = extractYamlValue(content, "server");

    if (!server) {
      throw new KubeApiError(
        "Unable to parse Kubernetes server from kubeconfig",
        500,
      );
    }

    const token = extractYamlValue(content, "token");
    const caData = extractYamlValue(content, "certificate-authority-data");
    const certData = extractYamlValue(content, "client-certificate-data");
    const keyData = extractYamlValue(content, "client-key-data");

    return {
      server,
      token,
      tls: {
        ca: caData ? decodeBase64(caData) : undefined,
        cert: certData ? decodeBase64(certData) : undefined,
        key: keyData ? decodeBase64(keyData) : undefined,
      },
    };
  }

  private buildUrl(server: string, path: string): string {
    const normalized = path.startsWith("/") ? path : `/${path}`;
    return `${server}${normalized}`;
  }

  private async toKubeError(
    response: Response,
    fallbackMessage: string,
  ): Promise<KubeApiError> {
    const payload = (await response
      .json()
      .catch(() => ({ message: fallbackMessage }))) as {
      message?: string;
      reason?: string;
    };

    const message = payload.message ?? fallbackMessage;
    return new KubeApiError(message, response.status, payload.reason);
  }
}

function extractYamlValue(content: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\s*${escaped}:\\s*(.+)$`, "m");
  const match = content.match(pattern);
  if (!match) {
    return undefined;
  }

  const raw = match[1]?.trim();
  if (!raw) {
    return undefined;
  }

  return raw.replace(/^['"]|['"]$/g, "");
}

function decodeBase64(value: string): string {
  return Buffer.from(value, "base64").toString();
}

function resourceCollectionPath(kind: string, namespace: string): string {
  const normalized = kind.toLowerCase();
  if (normalized === "pod") return `/api/v1/namespaces/${namespace}/pods`;
  if (normalized === "service")
    return `/api/v1/namespaces/${namespace}/services`;
  if (normalized === "configmap")
    return `/api/v1/namespaces/${namespace}/configmaps`;
  if (normalized === "persistentvolumeclaim")
    return `/api/v1/namespaces/${namespace}/persistentvolumeclaims`;
  if (normalized === "ingress")
    return `/apis/networking.k8s.io/v1/namespaces/${namespace}/ingresses`;
  if (normalized === "volumesnapshot") {
    return `/apis/snapshot.storage.k8s.io/v1/namespaces/${namespace}/volumesnapshots`;
  }
  if (normalized === "pipe") {
    return `/apis/sshpiper.com/v1beta1/namespaces/${namespace}/pipes`;
  }
  if (normalized === "secret") {
    return `/api/v1/namespaces/${namespace}/secrets`;
  }

  throw new KubeApiError(`Unsupported Kubernetes kind: ${kind}`, 400);
}

function resourceItemPath(
  kind: string,
  name: string,
  namespace: string,
): string {
  const base = resourceCollectionPath(kind, namespace);
  return `${base}/${name}`;
}
