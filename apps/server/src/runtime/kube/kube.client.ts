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

  /** Strategic-merge-patch a namespaced resource by kind/name. */
  async patchResource(
    kind: string,
    name: string,
    body: unknown,
    namespace = this.namespace,
  ): Promise<void> {
    if (isMock()) {
      return;
    }

    const path = resourceItemPath(kind, name, namespace);
    await this.patch(path, body);
  }

  async deleteLabeledResources(
    labelSelector: string,
    namespace = this.namespace,
  ): Promise<void> {
    if (isMock()) {
      return;
    }

    const selector = encodeURIComponent(labelSelector);
    const failures: string[] = [];
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
          // A concurrent delete already removed it — that's the goal state.
          await this.delete(`${base}/${name}`).catch((err) => {
            if (err instanceof KubeApiError && err.status === 404) return;
            throw err;
          });
        }
      } catch (err) {
        // A 404 on the *list* means the CRD isn't installed (volumesnapshots,
        // pipes) — nothing to sweep. Anything else is a real failure the
        // caller must see (destroy keeps the record for retry on failure) —
        // but keep sweeping the remaining collections first, so one broken
        // collection (e.g. an RBAC gap) doesn't leak everything after it.
        if (err instanceof KubeApiError && err.status === 404) continue;
        const message = err instanceof Error ? err.message : String(err);
        log.warn(
          { collection: col.path, error: message },
          "labeled-resource sweep failed for collection",
        );
        failures.push(`${col.path}: ${message}`);
      }
    }
    if (failures.length > 0) {
      throw new KubeApiError(
        `Labeled-resource sweep incomplete (${failures.join("; ")})`,
        500,
      );
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

  /**
   * Stream a pod container's logs (`follow=true`) to `onLog` chunk-by-chunk.
   * Unlike `request()` this must NOT buffer/JSON-parse: build Jobs emit
   * minutes of plain-text output the caller relays to an async job's `/logs`.
   * Resolves when the stream ends (container exited) or `signal` aborts;
   * throws a `KubeApiError` if the log endpoint rejects (e.g. the container
   * hasn't started yet — the caller retries against pod status).
   */
  async streamPodLogs(
    podName: string,
    onLog: (chunk: string) => void,
    options: {
      container?: string;
      namespace?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<void> {
    if (isMock()) return;

    const namespace = options.namespace ?? this.namespace;
    const auth = await this.getAuthConfig();
    const query = new URLSearchParams({ follow: "true" });
    if (options.container) query.set("container", options.container);
    const url = this.buildUrl(
      auth.server,
      `/api/v1/namespaces/${namespace}/pods/${podName}/log?${query}`,
    );

    const response = await fetch(url, {
      method: "GET",
      headers: this.buildHeaders(auth, { Accept: "text/plain" }),
      signal: options.signal,
      tls: auth.tls,
    } as BunRequestInit);

    if (!response.ok || !response.body) {
      throw await this.toKubeError(response, `Log stream failed: ${podName}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) onLog(decoder.decode(value, { stream: true }));
      }
    } finally {
      reader.releaseLock();
    }
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
      let response: Response;
      try {
        response = await fetch(url, {
          method: options.method,
          headers: this.buildHeaders(auth, options.headers),
          body: options.body ? JSON.stringify(options.body) : undefined,
          tls: auth.tls,
        } as BunRequestInit);
      } catch (err) {
        // Transport failures (ECONNRESET, DNS, TLS) never reach the HTTP
        // retry check below — retry them under the same backoff policy.
        if (attempt === MAX_ATTEMPTS) {
          throw new KubeApiError(
            `Request failed: ${path}: ${err instanceof Error ? err.message : String(err)}`,
            503,
          );
        }
        const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
        log.warn(
          { path, err, attempt, delay },
          "Kubernetes request errored, retrying",
        );
        await Bun.sleep(delay);
        continue;
      }

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
    // Real YAML parse honoring `current-context`: the previous regex scraper
    // grabbed the FIRST `server:`/`token:` in the file, silently pointing at
    // the wrong cluster on any multi-context kubeconfig.
    const kc = Bun.YAML.parse(content) as Kubeconfig;
    // No/unknown current-context: fall back to the sole context (common in
    // generated single-cluster kubeconfigs like k3s's).
    const context = (
      kc.contexts?.find((c) => c.name === kc["current-context"]) ??
      kc.contexts?.[0]
    )?.context;
    const cluster = (
      kc.clusters?.find((c) => c.name === context?.cluster) ?? kc.clusters?.[0]
    )?.cluster;
    const user = (
      kc.users?.find((u) => u.name === context?.user) ?? kc.users?.[0]
    )?.user;

    if (!cluster?.server) {
      throw new KubeApiError(
        "Unable to resolve a cluster server from kubeconfig",
        500,
      );
    }

    return {
      server: cluster.server,
      token: user?.token,
      tls: {
        ca: cluster["certificate-authority-data"]
          ? decodeBase64(cluster["certificate-authority-data"])
          : undefined,
        cert: user?.["client-certificate-data"]
          ? decodeBase64(user["client-certificate-data"])
          : undefined,
        key: user?.["client-key-data"]
          ? decodeBase64(user["client-key-data"])
          : undefined,
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

/** The subset of a kubeconfig document `loadKubeconfigAuth` reads. */
interface Kubeconfig {
  "current-context"?: string;
  contexts?: Array<{
    name?: string;
    context?: { cluster?: string; user?: string };
  }>;
  clusters?: Array<{
    name?: string;
    cluster?: { server?: string; "certificate-authority-data"?: string };
  }>;
  users?: Array<{
    name?: string;
    user?: {
      token?: string;
      "client-certificate-data"?: string;
      "client-key-data"?: string;
    };
  }>;
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
