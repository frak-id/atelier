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

const AUTH_POLL_INTERVAL_MS = 5_000;

export class InternalService {
  private authPollTimer: Timer | null = null;

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

    this.authPollTimer = setInterval(() => {
      this.pollAuthFromNfs();
    }, AUTH_POLL_INTERVAL_MS);

    log.info(
      { dir, intervalMs: AUTH_POLL_INTERVAL_MS },
      "Auth NFS polling started",
    );
  }

  stopAuthNfsWatcher(): void {
    if (this.authPollTimer) {
      clearInterval(this.authPollTimer);
      this.authPollTimer = null;
    }
  }

  private pollAuthFromNfs(): void {
    for (const provider of AUTH_PROVIDERS) {
      const filePath = path.join(NFS.AUTH_EXPORT_DIR, `${provider.name}.json`);

      try {
        if (!fs.existsSync(filePath)) continue;
        const content = fs.readFileSync(filePath, "utf-8");

        const existing = this.sharedAuthRepository.getByProvider(provider.name);
        if (existing?.content === content) continue;

        this.sharedAuthRepository.upsert(provider.name, content, "nfs");
        log.info({ provider: provider.name }, "Auth synced from NFS to DB");
      } catch (error) {
        log.error(
          { provider: provider.name, error },
          "Failed to sync auth from NFS",
        );
      }
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
        const tmpPath = `${nfsPath}.tmp`;
        await Bun.write(tmpPath, auth.content);
        await Bun.$`chown 1000:1000 ${tmpPath}`.quiet();
        await Bun.$`mv ${tmpPath} ${nfsPath}`.quiet();
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
