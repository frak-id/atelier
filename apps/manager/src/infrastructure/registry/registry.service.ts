import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { REGISTRY } from "@frak/atelier-shared/constants";
import { config, isMock } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import { appPaths } from "../../shared/lib/paths.ts";
import { CronService } from "../cron/index.ts";
import { kubeClient } from "../kubernetes/index.ts";
import {
  buildConfigMap,
  buildVerdaccioPod,
  buildVerdaccioService,
} from "../kubernetes/kube.resources.ts";

const log = createChildLogger("registry");

// ---------------------------------------------------------------------------
// K8s resource names
// ---------------------------------------------------------------------------

const POD_NAME = "verdaccio";
const SERVICE_NAME = "verdaccio";
const CONFIGMAP_NAME = "verdaccio-config";

// ---------------------------------------------------------------------------
// Settings persistence (local JSON — simple, survives pod restarts)
// ---------------------------------------------------------------------------

const SETTINGS_FILE = () => path.join(appPaths.data, "registry-settings.json");

export interface RegistrySettings {
  enabled: boolean;
  evictionDays: number;
}

const DEFAULT_SETTINGS: RegistrySettings = {
  enabled: false,
  evictionDays: REGISTRY.EVICTION_DAYS,
};

interface RegistryState {
  settings: RegistrySettings;
}

const state: RegistryState = {
  settings: { ...DEFAULT_SETTINGS },
};

function loadSettings(): RegistrySettings {
  const filePath = SETTINGS_FILE();
  if (!existsSync(filePath)) return { ...DEFAULT_SETTINGS };
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    return { ...DEFAULT_SETTINGS, ...raw };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings: RegistrySettings): void {
  const filePath = SETTINGS_FILE();
  writeFileSync(filePath, JSON.stringify(settings, null, 2));
}

// ---------------------------------------------------------------------------
// Verdaccio K8s helpers
// ---------------------------------------------------------------------------

function namespace(): string {
  return config.kubernetes.systemNamespace;
}

function verdaccioUrl(): string {
  const port = config.advanced.server.verdaccio.port;
  return `http://${SERVICE_NAME}.${namespace()}.svc:${port}`;
}

/** Build Verdaccio config.yaml content for the ConfigMap. */
function buildVerdaccioConfigYaml(): string {
  const port = config.advanced.server.verdaccio.port;
  return [
    "storage: /verdaccio/storage/packages",
    "",
    "auth:",
    "  htpasswd:",
    "    file: /verdaccio/storage/htpasswd",
    "    max_users: 1000",
    "",
    "uplinks:",
    "  npmjs:",
    "    url: https://registry.npmjs.org/",
    "    cache: true",
    "    maxage: 30m",
    "    fail_timeout: 5m",
    "    timeout: 30s",
    "",
    "packages:",
    '  "@*/*":',
    "    access: $all",
    "    proxy: npmjs",
    '  "**":',
    "    access: $all",
    "    proxy: npmjs",
    "",
    "server:",
    "  keepAliveTimeout: 60",
    "",
    `listen: 0.0.0.0:${port}`,
    "",
    "log:",
    "  type: stdout",
    "  format: pretty",
    "  level: warn",
    "",
    "max_body_size: 500mb",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export const RegistryService = {
  async initialize(): Promise<void> {
    state.settings = loadSettings();

    if (state.settings.enabled) {
      log.info("Registry enabled, starting on boot");
      await this.start().catch((err) => {
        log.error({ err }, "Failed to start registry on boot");
      });
    }
  },

  // -- Lifecycle ------------------------------------------------------------

  async start(): Promise<void> {
    if (isMock()) {
      log.info("Mock: Registry start skipped");
      state.settings.enabled = true;
      saveSettings(state.settings);
      return;
    }

    const ns = namespace();
    const labels = { "atelier.dev/component": "registry" };

    // 1. ConfigMap with Verdaccio config
    const configYaml = buildVerdaccioConfigYaml();
    await kubeClient.createResource(
      buildConfigMap(CONFIGMAP_NAME, { "config.yaml": configYaml }, ns, labels),
      ns,
    );

    // 2. Pod
    await kubeClient.createResource(buildVerdaccioPod(ns), ns);

    // 3. Service
    await kubeClient.createResource(buildVerdaccioService(ns), ns);

    // 4. Wait for health (120s — cold image pull can take a while)
    log.info("Waiting for Verdaccio pod to become healthy…");
    const healthy = await this.waitForHealthy(120_000);
    if (!healthy) {
      await this.deleteResources();
      throw new Error("Verdaccio pod failed to become healthy within 120 s");
    }

    state.settings.enabled = true;
    saveSettings(state.settings);
    this.registerEvictionCron();

    log.info("Registry started successfully");
  },

  async stop(): Promise<void> {
    if (isMock()) {
      log.info("Mock: Registry stop");
      state.settings.enabled = false;
      saveSettings(state.settings);
      return;
    }

    await this.deleteResources();

    state.settings.enabled = false;
    saveSettings(state.settings);

    log.info("Registry stopped");
  },

  kill(): void {
    // In K8s mode the pod is managed externally — nothing to force-close.
  },

  /** Delete all K8s resources created by start(). */
  async deleteResources(): Promise<void> {
    const ns = namespace();
    try {
      await kubeClient.deleteResource("Pod", POD_NAME, ns);
    } catch {}
    try {
      await kubeClient.deleteResource("Service", SERVICE_NAME, ns);
    } catch {}
    try {
      await kubeClient.deleteResource("ConfigMap", CONFIGMAP_NAME, ns);
    } catch {}
  },

  // -- Settings -------------------------------------------------------------

  async updateSettings(
    update: Partial<Pick<RegistrySettings, "evictionDays">>,
  ): Promise<RegistrySettings> {
    if (update.evictionDays !== undefined) {
      state.settings.evictionDays = update.evictionDays;
    }
    saveSettings(state.settings);
    return { ...state.settings };
  },

  getSettings(): RegistrySettings {
    return { ...state.settings };
  },

  isRunning(): boolean {
    return state.settings.enabled;
  },

  // -- Health ---------------------------------------------------------------

  async checkHealth(): Promise<boolean> {
    if (isMock()) return state.settings.enabled;
    try {
      const res = await fetch(`${verdaccioUrl()}/-/ping`, {
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  },

  async waitForHealthy(timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await this.checkHealth()) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  },

  // -- Stats (via Verdaccio HTTP API) ---------------------------------------

  async getPackageCount(): Promise<number> {
    if (isMock()) return state.settings.enabled ? 42 : 0;
    try {
      const res = await fetch(`${verdaccioUrl()}/-/v1/search?text=&size=250`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return 0;
      const data = (await res.json()) as {
        objects?: unknown[];
      };
      return data.objects?.length ?? 0;
    } catch {
      return 0;
    }
  },

  async checkUplinkHealth(): Promise<boolean> {
    if (isMock()) return true;
    try {
      const res = await fetch("https://registry.npmjs.org/-/ping", {
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  },

  async getStatus() {
    const [online, packageCount, uplinkHealthy] = await Promise.all([
      this.checkHealth(),
      this.getPackageCount(),
      this.checkUplinkHealth(),
    ]);

    return {
      enabled: state.settings.enabled,
      online,
      packageCount,
      uplink: {
        url: "https://registry.npmjs.org",
        healthy: uplinkHealthy,
      },
      settings: {
        evictionDays: state.settings.evictionDays,
      },
    };
  },

  // -- Cache management (via Verdaccio HTTP API) ----------------------------

  async purgeCache(): Promise<{ deletedCount: number }> {
    if (isMock()) {
      log.info("Mock: Cache purge");
      return { deletedCount: 10 };
    }

    const packages = await this.listPackages();
    let deletedCount = 0;
    for (const pkg of packages) {
      if (await this.deletePackage(pkg.name)) deletedCount++;
    }

    log.info({ deletedCount }, "Cache purged");
    return { deletedCount };
  },

  async runEvictionNow(): Promise<number> {
    if (isMock()) return 0;

    const packages = await this.listPackages();
    const cutoff = Date.now() - state.settings.evictionDays * 86_400_000;
    let deletedCount = 0;

    for (const pkg of packages) {
      const modifiedAt = pkg.date ? new Date(pkg.date).getTime() : 0;
      if (modifiedAt > 0 && modifiedAt < cutoff) {
        if (await this.deletePackage(pkg.name)) deletedCount++;
      }
    }

    if (deletedCount > 0) {
      log.info(
        {
          deletedCount,
          evictionDays: state.settings.evictionDays,
        },
        "Cache eviction completed",
      );
    }

    return deletedCount;
  },

  registerEvictionCron(): void {
    CronService.add("registryEviction", {
      name: "Registry Cache Eviction",
      pattern: "0 3 * * *",
      handler: async () => {
        await this.runEvictionNow();
      },
    });
  },

  // -- Package helpers (Verdaccio REST API) ---------------------------------

  /**
   * List all cached packages via the Verdaccio search endpoint.
   * Paginates automatically until all packages are returned.
   */
  async listPackages(): Promise<{ name: string; date?: string }[]> {
    const packages: { name: string; date?: string }[] = [];
    let from = 0;
    const size = 250;

    while (true) {
      try {
        const url = `${verdaccioUrl()}/-/v1/search?text=&size=${size}&from=${from}`;
        const res = await fetch(url, {
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) break;

        const data = (await res.json()) as {
          objects?: {
            package?: { name?: string; date?: string };
          }[];
        };

        const objects = data.objects ?? [];
        if (objects.length === 0) break;

        for (const obj of objects) {
          if (obj.package?.name) {
            packages.push({
              name: obj.package.name,
              date: obj.package.date,
            });
          }
        }

        from += size;
        if (objects.length < size) break;
      } catch {
        break;
      }
    }

    return packages;
  },

  /**
   * Delete a single cached package via the Verdaccio unpublish
   * API.  Fetches metadata first to obtain the revision hash.
   */
  async deletePackage(packageName: string): Promise<boolean> {
    try {
      const encoded = encodeURIComponent(packageName);

      // 1. Get metadata (includes _rev)
      const metaRes = await fetch(`${verdaccioUrl()}/${encoded}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!metaRes.ok) return false;

      const meta = (await metaRes.json()) as {
        _rev?: string;
      };
      if (!meta._rev) return false;

      // 2. Delete
      const delRes = await fetch(
        `${verdaccioUrl()}/${encoded}/-rev/${meta._rev}`,
        {
          method: "DELETE",
          signal: AbortSignal.timeout(5000),
        },
      );
      return delRes.ok || delRes.status === 201;
    } catch {
      return false;
    }
  },

  // -- Misc -----------------------------------------------------------------

  getRegistryUrl(): string {
    return verdaccioUrl();
  },
};
