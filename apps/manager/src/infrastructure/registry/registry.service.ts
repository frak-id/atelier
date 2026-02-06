import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import type { Server } from "node:http";
import path from "node:path";
import { REGISTRY } from "@frak/atelier-shared/constants";
import { $ } from "bun";
import { config, isMock } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import { appPaths } from "../../shared/lib/paths.ts";
import { CronService } from "../cron/index.ts";

const log = createChildLogger("registry");

/**
 * Verdaccio must run unbundled — its plugins (htpasswd, audit, logger-prettify)
 * are loaded via dynamic require() which breaks in Bun's bundled output.
 * We install it in a dedicated directory and dynamically import runServer().
 */
const VERDACCIO_DIR = REGISTRY.PACKAGES_DIR;
const VERDACCIO_PKG = "verdaccio";
const VERDACCIO_VERSION = config.advanced.server.verdaccio.version;

const SETTINGS_FILE = () => path.join(appPaths.data, "registry-settings.json");

export interface RegistrySettings {
  enabled: boolean;
  evictionDays: number;
  storagePath: string;
}

const DEFAULT_SETTINGS: RegistrySettings = {
  enabled: false,
  evictionDays: REGISTRY.EVICTION_DAYS,
  storagePath: REGISTRY.STORAGE_DIR,
};

interface RegistryState {
  server: Server | null;
  settings: RegistrySettings;
}

const state: RegistryState = {
  server: null,
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

function buildVerdaccioConfig(settings: RegistrySettings) {
  return {
    storage: settings.storagePath,
    self_path: path.dirname(settings.storagePath),
    configPath: path.dirname(settings.storagePath),
    auth: {
      htpasswd: {
        file: path.join(settings.storagePath, "htpasswd"),
        max_users: 1000,
      },
    },
    uplinks: {
      npmjs: {
        url: "https://registry.npmjs.org/",
        cache: true,
        maxage: "30m",
        fail_timeout: "5m",
        timeout: "30s",
        strict_ssl: false,
      },
    },
    packages: {
      "@*/*": { access: "$all", proxy: "npmjs" },
      "**": { access: "$all", proxy: "npmjs" },
    },
    server: { keepAliveTimeout: 60 },
    security: {
      api: { legacy: true },
      web: { sign: {}, verify: {} },
    },
    middlewares: {
      audit: { enabled: true },
    },
    log: { type: "stdout", format: "pretty", level: "warn" },
    max_body_size: "500mb",
  };
}

async function ensureVerdaccioInstalled(): Promise<void> {
  const modulePath = path.join(VERDACCIO_DIR, "node_modules", VERDACCIO_PKG);
  const pkgJsonPath = path.join(VERDACCIO_DIR, "package.json");

  if (existsSync(modulePath)) {
    try {
      const deps = JSON.parse(readFileSync(pkgJsonPath, "utf-8")).dependencies;
      if (deps?.[VERDACCIO_PKG] === VERDACCIO_VERSION) return;
    } catch {}
  }

  await mkdir(VERDACCIO_DIR, { recursive: true });
  if (!existsSync(pkgJsonPath)) {
    writeFileSync(
      pkgJsonPath,
      JSON.stringify(
        { name: "atelier-registry-cache", private: true },
        null,
        2,
      ),
    );
  }

  log.info(
    { pkg: VERDACCIO_PKG, version: VERDACCIO_VERSION },
    "Installing Verdaccio",
  );

  const result =
    await $`bun add --force --exact --cwd ${VERDACCIO_DIR} ${`${VERDACCIO_PKG}@${VERDACCIO_VERSION}`}`
      .quiet()
      .nothrow();

  if (result.exitCode !== 0) {
    throw new Error(`Failed to install verdaccio: ${result.stderr.toString()}`);
  }

  log.info("Verdaccio installed");
}

async function importRunServer(): Promise<
  (config: unknown) => Promise<{ listen: Server["listen"] }>
> {
  const verdaccioPath = path.join(VERDACCIO_DIR, "node_modules", VERDACCIO_PKG);
  const mod = await import(verdaccioPath);
  return mod.runServer;
}

async function runEviction(settings: RegistrySettings): Promise<number> {
  const storagePath = settings.storagePath;
  if (!existsSync(storagePath)) return 0;

  const result =
    await $`find ${storagePath} -name "*.tgz" -atime +${settings.evictionDays} -delete -print 2>/dev/null`
      .quiet()
      .nothrow();

  await $`find ${storagePath} -type d -empty -delete 2>/dev/null`
    .quiet()
    .nothrow();

  const deletedCount = result.stdout
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean).length;

  if (deletedCount > 0) {
    log.info(
      { deletedCount, evictionDays: settings.evictionDays },
      "Cache eviction completed",
    );
  }

  return deletedCount;
}

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

  async start(): Promise<void> {
    if (isMock()) {
      log.info("Mock: Registry start skipped");
      state.settings.enabled = true;
      saveSettings(state.settings);
      return;
    }

    if (state.server) {
      log.warn("Registry already running");
      return;
    }

    await ensureVerdaccioInstalled();
    await mkdir(state.settings.storagePath, { recursive: true });

    const verdaccioConfig = buildVerdaccioConfig(state.settings);
    const runServer = await importRunServer();

    log.info(
      { port: config.advanced.server.verdaccio.port },
      "Starting Verdaccio via programmatic API",
    );

    const app = await runServer(verdaccioConfig);

    await new Promise<void>((resolve, reject) => {
      const server = app.listen(
        config.advanced.server.verdaccio.port,
        "0.0.0.0",
        () => {
          log.info(
            { port: config.advanced.server.verdaccio.port, host: "0.0.0.0" },
            "Verdaccio listening",
          );
          resolve();
        },
      );
      server.on("error", (err: Error) => {
        reject(err);
      });
      state.server = server;
    });

    const healthy = await this.waitForHealthy(10000);
    if (!healthy) {
      this.kill();
      throw new Error("Verdaccio failed to become healthy within 10 seconds");
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

    this.kill();

    state.settings.enabled = false;
    saveSettings(state.settings);

    log.info("Registry stopped");
  },

  kill(): void {
    if (state.server) {
      state.server.close();
      state.server = null;
    }
  },

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
    return state.server !== null;
  },

  async checkHealth(): Promise<boolean> {
    if (isMock()) return state.settings.enabled;
    try {
      const res = await fetch(
        `http://127.0.0.1:${config.advanced.server.verdaccio.port}/-/ping`,
        {
          signal: AbortSignal.timeout(3000),
        },
      );
      return res.ok;
    } catch {
      return false;
    }
  },

  async getPackageCount(): Promise<number> {
    if (isMock()) return state.settings.enabled ? 42 : 0;
    try {
      const storagePath = state.settings.storagePath;
      if (!existsSync(storagePath)) return 0;
      const result =
        await $`find ${storagePath} -maxdepth 2 -name "package.json" -not -path "*/node_modules/*" 2>/dev/null | wc -l`
          .quiet()
          .nothrow();
      return Number.parseInt(result.stdout.toString().trim(), 10) || 0;
    } catch {
      return 0;
    }
  },

  async getDiskStats(): Promise<{
    usedBytes: number;
    totalBytes: number;
    usedPercent: number;
  }> {
    if (isMock()) {
      return state.settings.enabled
        ? {
            usedBytes: 1024 * 1024 * 500,
            totalBytes: 1024 * 1024 * 1024 * 60,
            usedPercent: 0.8,
          }
        : { usedBytes: 0, totalBytes: 0, usedPercent: 0 };
    }
    try {
      const [duResult, dfResult] = await Promise.all([
        $`du -sb ${state.settings.storagePath} 2>/dev/null | cut -f1`
          .quiet()
          .nothrow(),
        $`df -B1 ${state.settings.storagePath} 2>/dev/null | tail -1 | awk '{print $2}'`
          .quiet()
          .nothrow(),
      ]);

      const usedBytes =
        Number.parseInt(duResult.stdout.toString().trim(), 10) || 0;
      const totalBytes =
        Number.parseInt(dfResult.stdout.toString().trim(), 10) || 0;
      const usedPercent = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;

      return { usedBytes, totalBytes, usedPercent };
    } catch (err) {
      log.debug({ err }, "Failed to get disk stats");
    }
    return { usedBytes: 0, totalBytes: 0, usedPercent: 0 };
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
    const [online, packageCount, disk, uplinkHealthy] = await Promise.all([
      this.checkHealth(),
      this.getPackageCount(),
      this.getDiskStats(),
      this.checkUplinkHealth(),
    ]);

    return {
      enabled: state.settings.enabled,
      online,
      packageCount,
      disk,
      uplink: {
        url: "https://registry.npmjs.org",
        healthy: uplinkHealthy,
      },
      settings: {
        evictionDays: state.settings.evictionDays,
        storagePath: state.settings.storagePath,
      },
    };
  },

  async purgeCache(): Promise<{ freedBytes: number }> {
    if (isMock()) {
      log.info("Mock: Cache purge");
      return { freedBytes: 1024 * 1024 * 200 };
    }

    const storagePath = state.settings.storagePath;
    if (!existsSync(storagePath)) return { freedBytes: 0 };

    const beforeResult = await $`du -sb ${storagePath} 2>/dev/null | cut -f1`
      .quiet()
      .nothrow();
    const beforeBytes =
      Number.parseInt(beforeResult.stdout.toString().trim(), 10) || 0;

    await $`find ${storagePath} -name "*.tgz" -delete 2>/dev/null`
      .quiet()
      .nothrow();
    await $`find ${storagePath} -type d -empty -delete 2>/dev/null`
      .quiet()
      .nothrow();

    const afterResult = await $`du -sb ${storagePath} 2>/dev/null | cut -f1`
      .quiet()
      .nothrow();
    const afterBytes =
      Number.parseInt(afterResult.stdout.toString().trim(), 10) || 0;

    const freedBytes = Math.max(0, beforeBytes - afterBytes);
    log.info({ freedBytes }, "Cache purged");
    return { freedBytes };
  },

  async runEvictionNow(): Promise<number> {
    return runEviction(state.settings);
  },

  registerEvictionCron(): void {
    CronService.add("registryEviction", {
      name: "Registry Cache Eviction",
      pattern: "0 3 * * *",
      handler: async () => {
        await runEviction(state.settings);
      },
    });
  },

  getRegistryUrl(): string {
    return `http://${config.network.bridgeIp}:${config.advanced.server.verdaccio.port}`;
  },

  async waitForHealthy(timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await this.checkHealth()) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  },
};
