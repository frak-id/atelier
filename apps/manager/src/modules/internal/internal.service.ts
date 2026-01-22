import { NFS } from "@frak-sandbox/shared/constants";
import { createChildLogger } from "../../shared/lib/logger.ts";
import type { SharedAuthRepository } from "./internal.repository.ts";

const log = createChildLogger("internal-service");

export const KNOWN_AUTH_PROVIDERS = [
  {
    name: "opencode",
    path: "/home/dev/.local/share/opencode/auth.json",
    description: "OpenCode authentication (Anthropic, XAI, OpenCode API keys)",
  },
  {
    name: "antigravity",
    path: "/home/dev/.config/opencode/antigravity-accounts.json",
    description: "Google Antigravity plugin accounts",
  },
] as const;

export interface AuthContent {
  content: string;
  updatedAt: string;
  updatedBy: string | null;
}

export interface AuthSyncResult {
  action: "updated" | "unchanged" | "conflict";
  content: string;
  updatedAt: string;
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
  private readonly authLocks = new Map<string, Promise<AuthSyncResult>>();

  constructor(private readonly sharedAuthRepository: SharedAuthRepository) {}

  listAuth(): SharedAuthInfo[] {
    const storedAuth = this.sharedAuthRepository.list();
    const storedByProvider = new Map(storedAuth.map((a) => [a.provider, a]));

    return KNOWN_AUTH_PROVIDERS.map((provider) => {
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
    const providerInfo = KNOWN_AUTH_PROVIDERS.find((p) => p.name === provider);
    if (!providerInfo) {
      throw new Error(`Unknown auth provider: ${provider}`);
    }

    const record = this.sharedAuthRepository.upsert(
      provider,
      content,
      "dashboard",
    );

    log.info({ provider }, "Auth updated from dashboard");

    return {
      provider: record.provider,
      path: providerInfo.path,
      description: providerInfo.description,
      content: record.content,
      updatedAt: record.updatedAt,
      updatedBy: record.updatedBy,
    };
  }

  async syncAuth(
    provider: string,
    content: string,
    sandboxId: string,
    clientUpdatedAt?: string,
  ): Promise<AuthSyncResult> {
    const existingLock = this.authLocks.get(provider);
    if (existingLock) {
      log.debug({ provider, sandboxId }, "Waiting for existing auth sync");
      return existingLock;
    }

    const syncPromise = this.doSyncAuth(
      provider,
      content,
      sandboxId,
      clientUpdatedAt,
    );
    this.authLocks.set(provider, syncPromise);

    try {
      return await syncPromise;
    } finally {
      this.authLocks.delete(provider);
    }
  }

  private async doSyncAuth(
    provider: string,
    content: string,
    sandboxId: string,
    clientUpdatedAt?: string,
  ): Promise<AuthSyncResult> {
    const existing = this.sharedAuthRepository.getByProvider(provider);

    if (existing && clientUpdatedAt) {
      const serverTime = new Date(existing.updatedAt).getTime();
      const clientTime = new Date(clientUpdatedAt).getTime();

      if (serverTime > clientTime) {
        log.debug(
          { provider, sandboxId, serverTime, clientTime },
          "Auth conflict - server has newer version",
        );
        return {
          action: "conflict",
          content: existing.content,
          updatedAt: existing.updatedAt,
        };
      }
    }

    const record = this.sharedAuthRepository.upsert(
      provider,
      content,
      sandboxId,
    );

    log.info({ provider, sandboxId }, "Auth synced");

    return {
      action: existing ? "updated" : "updated",
      content: record.content,
      updatedAt: record.updatedAt,
    };
  }

  async syncConfigsToNfs(): Promise<{ synced: number }> {
    const { ConfigFileService } = await import(
      "../config-file/config-file.service.ts"
    );
    const { ConfigFileRepository } = await import(
      "../config-file/config-file.repository.ts"
    );

    const configFileRepository = new ConfigFileRepository();
    const configFileService = new ConfigFileService(configFileRepository);

    const globalConfigs = configFileService.list({ scope: "global" });

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

    const workspaceConfigs = configFileService.list({ scope: "workspace" });
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
