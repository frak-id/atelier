import * as fs from "node:fs";
import * as path from "node:path";
import { AUTH_PROVIDERS, NFS } from "@frak-sandbox/shared/constants";
import { createChildLogger } from "../../shared/lib/logger.ts";
import type { ConfigFileService } from "../config-file/config-file.service.ts";
import type { SharedAuthRepository } from "./internal.repository.ts";

const log = createChildLogger("internal-service");

export interface AuthContent {
  content: string;
  updatedAt: string;
  updatedBy: string | null;
}

export interface SharedAuthInfo {
  provider: string;
  path: string;
  description: string;
  content: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export class InternalService {
  private readonly authWatchers = new Map<string, fs.FSWatcher>();
  private readonly authDebounceTimers = new Map<string, Timer>();

  constructor(
    private readonly sharedAuthRepository: SharedAuthRepository,
    private readonly configFileService: ConfigFileService,
  ) {}

  startAuthNfsWatcher(): void {
    const dir = NFS.AUTH_EXPORT_DIR;

    if (!fs.existsSync(dir)) {
      log.warn(
        { dir },
        "Auth NFS export directory does not exist, skipping watcher",
      );
      return;
    }

    for (const provider of AUTH_PROVIDERS) {
      const filename = `${provider.name}.json`;
      const filePath = path.join(dir, filename);

      try {
        const watcher = fs.watch(dir, (eventType, changedFilename) => {
          if (changedFilename === filename && eventType === "change") {
            this.debouncedSyncFromNfs(provider.name, filePath);
          }
        });

        this.authWatchers.set(provider.name, watcher);
        log.info(
          { provider: provider.name, filePath },
          "Watching auth NFS file",
        );
      } catch (error) {
        log.error(
          { provider: provider.name, error },
          "Failed to watch auth NFS file",
        );
      }
    }
  }

  stopAuthNfsWatcher(): void {
    for (const timer of this.authDebounceTimers.values()) {
      clearTimeout(timer);
    }
    this.authDebounceTimers.clear();

    for (const watcher of this.authWatchers.values()) {
      watcher.close();
    }
    this.authWatchers.clear();
  }

  private debouncedSyncFromNfs(provider: string, filePath: string): void {
    const existing = this.authDebounceTimers.get(provider);
    if (existing) clearTimeout(existing);

    this.authDebounceTimers.set(
      provider,
      setTimeout(() => {
        this.authDebounceTimers.delete(provider);
        this.syncAuthFromNfs(provider, filePath);
      }, 500),
    );
  }

  private syncAuthFromNfs(provider: string, filePath: string): void {
    try {
      if (!fs.existsSync(filePath)) return;
      const content = fs.readFileSync(filePath, "utf-8");

      const existing = this.sharedAuthRepository.getByProvider(provider);
      if (existing?.content === content) return;

      this.sharedAuthRepository.upsert(provider, content, "nfs");
      log.info({ provider }, "Auth synced from NFS to DB");
    } catch (error) {
      log.error({ provider, error }, "Failed to sync auth from NFS");
    }
  }

  listAuth(): SharedAuthInfo[] {
    const storedAuth = this.sharedAuthRepository.list();
    const storedByProvider = new Map(storedAuth.map((a) => [a.provider, a]));

    return AUTH_PROVIDERS.map((provider) => {
      const stored = storedByProvider.get(provider.name);
      return {
        provider: provider.name,
        path: provider.path,
        description: provider.description,
        content: stored?.content ?? null,
        updatedAt: stored?.updatedAt ?? null,
        updatedBy: stored?.updatedBy ?? null,
      };
    });
  }

  async getAuth(provider: string): Promise<AuthContent | null> {
    const record = this.sharedAuthRepository.getByProvider(provider);
    if (!record) return null;

    return {
      content: record.content,
      updatedAt: record.updatedAt,
      updatedBy: record.updatedBy,
    };
  }

  updateAuth(provider: string, content: string): SharedAuthInfo {
    const providerInfo = AUTH_PROVIDERS.find((p) => p.name === provider);
    if (!providerInfo) {
      throw new Error(`Unknown auth provider: ${provider}`);
    }

    const record = this.sharedAuthRepository.upsert(
      provider,
      content,
      "dashboard",
    );

    log.info({ provider }, "Auth updated from dashboard");

    this.syncAuthToNfs().catch((error) => {
      log.error({ error }, "Failed to sync auth to NFS after dashboard update");
    });

    return {
      provider: record.provider,
      path: providerInfo.path,
      description: providerInfo.description,
      content: record.content,
      updatedAt: record.updatedAt,
      updatedBy: record.updatedBy,
    };
  }

  async syncAuthToNfs(): Promise<{ synced: number }> {
    const storedAuth = this.sharedAuthRepository.list();
    let synced = 0;

    for (const auth of storedAuth) {
      const nfsPath = `${NFS.AUTH_EXPORT_DIR}/${auth.provider}.json`;

      try {
        await Bun.write(nfsPath, auth.content);
        synced++;
        log.debug({ provider: auth.provider, nfsPath }, "Auth synced to NFS");
      } catch (error) {
        log.error(
          { provider: auth.provider, error },
          "Failed to sync auth to NFS",
        );
      }
    }

    log.info({ synced }, "Auth sync to NFS complete");
    return { synced };
  }

  async syncConfigsToNfs(): Promise<{ synced: number }> {
    const globalConfigs = this.configFileService.list({ scope: "global" });

    let synced = 0;

    for (const config of globalConfigs) {
      const nfsPath = `${NFS.CONFIGS_EXPORT_DIR}/${NFS.CONFIG_DIRS.GLOBAL}${config.path}`;
      const dir = nfsPath.substring(0, nfsPath.lastIndexOf("/"));

      try {
        await Bun.$`mkdir -p ${dir}`.quiet();

        if (config.contentType === "binary") {
          const buffer = Buffer.from(config.content, "base64");
          await Bun.write(nfsPath, buffer);
        } else {
          await Bun.write(nfsPath, config.content);
        }

        synced++;
        log.debug({ path: config.path, nfsPath }, "Config synced to NFS");
      } catch (error) {
        log.error({ path: config.path, error }, "Failed to sync config to NFS");
      }
    }

    const workspaceConfigs = this.configFileService.list({
      scope: "workspace",
    });
    const byWorkspace = new Map<string, typeof workspaceConfigs>();

    for (const config of workspaceConfigs) {
      if (!config.workspaceId) continue;
      const existing = byWorkspace.get(config.workspaceId) ?? [];
      existing.push(config);
      byWorkspace.set(config.workspaceId, existing);
    }

    for (const [workspaceId, configs] of byWorkspace) {
      for (const config of configs) {
        const nfsPath = `${NFS.CONFIGS_EXPORT_DIR}/${NFS.CONFIG_DIRS.WORKSPACES}/${workspaceId}${config.path}`;
        const dir = nfsPath.substring(0, nfsPath.lastIndexOf("/"));

        try {
          await Bun.$`mkdir -p ${dir}`.quiet();

          if (config.contentType === "binary") {
            const buffer = Buffer.from(config.content, "base64");
            await Bun.write(nfsPath, buffer);
          } else {
            await Bun.write(nfsPath, config.content);
          }

          synced++;
          log.debug(
            { path: config.path, nfsPath, workspaceId },
            "Workspace config synced to NFS",
          );
        } catch (error) {
          log.error(
            { path: config.path, workspaceId, error },
            "Failed to sync workspace config to NFS",
          );
        }
      }
    }

    log.info({ synced }, "Config sync to NFS complete");
    return { synced };
  }
}
