import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { REGISTRY } from "@frak-sandbox/shared/constants";
import { $ } from "bun";
import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import { appPaths } from "../../shared/lib/paths.ts";
import { CronService } from "../cron/index.ts";
import { installPackage, isPackageInstalled } from "./bun-install.ts";

const log = createChildLogger("registry");

const VERDACCIO_PKG = "verdaccio";
const VERDACCIO_VERSION = "6.2.4";

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
  process: ReturnType<typeof Bun.spawn> | null;
  settings: RegistrySettings;
}

const state: RegistryState = {
  process: null,
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

function generateVerdaccioConfig(settings: RegistrySettings): string {
  return `storage: ${settings.storagePath}

uplinks:
  npmjs:
    url: https://registry.npmjs.org/
    cache: true
    maxage: 30m
    fail_timeout: 5m
    timeout: 30s

packages:
  '@*/*':
    access: $all
    proxy: npmjs

  '**':
    access: $all
    proxy: npmjs

server:
  keepAliveTimeout: 60

middlewares:
  audit:
    enabled: true

log: { type: stdout, format: pretty, level: warn }

max_body_size: 500mb

listen: 0.0.0.0:${REGISTRY.PORT}
`;
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
    if (config.isMock()) {
      log.info("Mock: Registry start skipped");
      state.settings.enabled = true;
      saveSettings(state.settings);
      return;
    }

    if (state.process) {
      log.warn("Registry already running");
      return;
    }

    if (!isPackageInstalled(VERDACCIO_PKG, VERDACCIO_VERSION)) {
      log.info("Verdaccio not installed, installing...");
      await installPackage(VERDACCIO_PKG, VERDACCIO_VERSION);
    }

    await mkdir(state.settings.storagePath, { recursive: true });

    const configYaml = generateVerdaccioConfig(state.settings);
    await mkdir(path.dirname(REGISTRY.CONFIG_PATH), { recursive: true });
    writeFileSync(REGISTRY.CONFIG_PATH, configYaml);

    const verdaccioBin = path.join(
      "/var/lib/sandbox/registry/packages/node_modules",
      VERDACCIO_PKG,
      "bin",
      "verdaccio",
    );

    if (!existsSync(verdaccioBin)) {
      throw new Error(
        `Verdaccio binary not found at ${verdaccioBin}. Installation may have failed.`,
      );
    }

    log.info({ bin: verdaccioBin, port: REGISTRY.PORT }, "Starting Verdaccio");

    state.process = Bun.spawn(
      ["bun", verdaccioBin, "--config", REGISTRY.CONFIG_PATH],
      {
        cwd: path.dirname(REGISTRY.CONFIG_PATH),
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          VERDACCIO_APPDIR: path.dirname(REGISTRY.CONFIG_PATH),
        },
      },
    );

    state.process.exited.then((code) => {
      log.warn({ exitCode: code }, "Verdaccio process exited");
      state.process = null;
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
    if (config.isMock()) {
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
    if (state.process) {
      state.process.kill();
      state.process = null;
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
    return state.process !== null;
  },

  async checkHealth(): Promise<boolean> {
    if (config.isMock()) return state.settings.enabled;
    try {
      const res = await fetch(`http://127.0.0.1:${REGISTRY.PORT}/-/ping`, {
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  },

  async getPackageCount(): Promise<number> {
    if (config.isMock()) return state.settings.enabled ? 42 : 0;
    try {
      const res = await fetch(
        `http://127.0.0.1:${REGISTRY.PORT}/-/verdaccio/data/packages`,
        { signal: AbortSignal.timeout(5000) },
      );
      if (!res.ok) return 0;
      const packages = (await res.json()) as unknown[];
      return packages.length;
    } catch {
      return 0;
    }
  },

  async getDiskStats(): Promise<{
    usedBytes: number;
    totalBytes: number;
    usedPercent: number;
  }> {
    if (config.isMock()) {
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
      const usedPercent =
        totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;

      return { usedBytes, totalBytes, usedPercent };
    } catch (err) {
      log.debug({ err }, "Failed to get disk stats");
    }
    return { usedBytes: 0, totalBytes: 0, usedPercent: 0 };
  },

  async checkUplinkHealth(): Promise<boolean> {
    if (config.isMock()) return true;
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
    if (config.isMock()) {
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
    return `http://${config.network.bridgeIp}:${REGISTRY.PORT}`;
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
