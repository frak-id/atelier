import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { REGISTRY, VM } from "@frak/atelier-shared/constants";
import { config, isMock } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import { appPaths } from "../../shared/lib/paths.ts";
import type { FileWrite } from "../agent/agent.types.ts";
import { CronService } from "../cron/index.ts";

const log = createChildLogger("registry");

// ---------------------------------------------------------------------------
// Settings persistence (local JSON — eviction config only)
// ---------------------------------------------------------------------------

const SETTINGS_FILE = () => path.join(appPaths.data, "registry-settings.json");

export interface RegistrySettings {
  evictionDays: number;
}

const DEFAULT_SETTINGS: RegistrySettings = {
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
// Verdaccio URL helper
// ---------------------------------------------------------------------------

function verdaccioUrl(): string {
  return config.kubernetes.verdaccioUrl;
}

// ---------------------------------------------------------------------------
// Service (thin HTTP client — lifecycle managed by Helm chart)
// ---------------------------------------------------------------------------

export const RegistryService = {
  initialize(): void {
    state.settings = loadSettings();
    this.registerEvictionCron();
    log.info("Registry service initialized (pod managed by Helm)");
  },

  // -- Settings -------------------------------------------------------------

  updateSettings(
    update: Partial<Pick<RegistrySettings, "evictionDays">>,
  ): RegistrySettings {
    if (update.evictionDays !== undefined) {
      state.settings.evictionDays = update.evictionDays;
    }
    saveSettings(state.settings);
    return { ...state.settings };
  },

  getSettings(): RegistrySettings {
    return { ...state.settings };
  },

  // -- Health ---------------------------------------------------------------

  async checkHealth(): Promise<boolean> {
    if (isMock()) return true;
    try {
      const res = await fetch(`${verdaccioUrl()}/-/ping`, {
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  },

  /**
   * Like `checkHealth`, but waits up to `timeoutMs` for Verdaccio to come up.
   * Useful around prebuild start where Verdaccio may have just restarted and
   * a single ping racing with rollout would silently fall back to public npm.
   */
  async waitUntilHealthy(timeoutMs = 15_000): Promise<boolean> {
    if (isMock()) return true;
    const deadline = Date.now() + timeoutMs;
    let delay = 500;
    while (Date.now() < deadline) {
      if (await this.checkHealth()) return true;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 2_000);
    }
    return false;
  },

  // -- Stats (via Verdaccio HTTP API) ---------------------------------------

  async getPackageCount(): Promise<number> {
    if (isMock()) return 42;
    try {
      const packages = await this.listPackages();
      return packages.length;
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

  /**
   * Build the file writes that point npm/bun/yarn at our Verdaccio cache.
   *
   * Waits a few seconds for Verdaccio to be healthy. This avoids silently
   * falling back to public npm right after a Verdaccio restart — a single
   * ping racing with rollout would otherwise miss the recovery window.
   * Returns `null` when Verdaccio still isn't reachable so callers can decide.
   */
  async buildRegistryConfigFiles(): Promise<FileWrite[] | null> {
    const isHealthy = await this.waitUntilHealthy();
    if (!isHealthy) return null;

    const registryUrl = this.getRegistryUrl();
    const registryHost = new URL(registryUrl).hostname;

    return [
      {
        path: "/etc/profile.d/registry.sh",
        content: `export NPM_CONFIG_REGISTRY="${registryUrl}"`,
        owner: "root",
      },
      {
        path: "/etc/npmrc",
        content: `registry=${registryUrl}`,
        owner: "root",
      },
      {
        path: `${VM.HOME}/.bunfig.toml`,
        content: `[install]\nregistry = "${registryUrl}"`,
        owner: "dev",
      },
      {
        path: `${VM.HOME}/.yarnrc.yml`,
        content: `npmRegistryServer: "${registryUrl}"\nunsafeHttpWhitelist:\n  - "${registryHost}"`,
        owner: "dev",
      },
    ];
  },
};
