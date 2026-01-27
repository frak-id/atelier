import * as fs from "node:fs";
import * as path from "node:path";
import {
  AUTH_PROVIDERS,
  AUTH_SYNC_INTERVAL_MS,
  MANAGER_INTERNAL_URL,
  sandboxConfig,
} from "../constants";

interface AuthState {
  content: string;
  hash: string;
  updatedAt: string;
}

interface SyncResponse {
  action: "updated" | "unchanged" | "conflict";
  content: string;
  updatedAt: string;
}

function computeHash(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return hash.toString(16);
}

class AuthSyncService {
  private readonly states = new Map<string, AuthState>();
  private readonly watchers = new Map<string, fs.FSWatcher>();
  private intervalId: NodeJS.Timeout | null = null;
  private sandboxId: string | null = null;

  async start(): Promise<void> {
    this.sandboxId = sandboxConfig?.sandboxId ?? null;
    if (!this.sandboxId) {
      console.error("[auth-sync] No sandbox ID found, skipping auth sync");
      return;
    }

    console.log(`[auth-sync] Starting auth sync for sandbox ${this.sandboxId}`);

    for (const provider of AUTH_PROVIDERS) {
      await this.initProvider(provider.name, provider.path);
    }

    this.intervalId = setInterval(() => {
      this.pullAll();
    }, AUTH_SYNC_INTERVAL_MS);

    console.log(
      `[auth-sync] Auth sync started (interval: ${AUTH_SYNC_INTERVAL_MS}ms)`,
    );
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();

    console.log("[auth-sync] Auth sync stopped");
  }

  private async initProvider(
    provider: string,
    filePath: string,
  ): Promise<void> {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    await this.pullFromManager(provider, filePath);

    this.watchFile(provider, filePath);
  }

  private watchFile(provider: string, filePath: string): void {
    if (this.watchers.has(provider)) {
      this.watchers.get(provider)?.close();
    }

    const dir = path.dirname(filePath);
    const filename = path.basename(filePath);

    try {
      const watcher = fs.watch(dir, (eventType, changedFilename) => {
        if (changedFilename === filename && eventType === "change") {
          this.handleFileChange(provider, filePath);
        }
      });

      this.watchers.set(provider, watcher);
      console.log(`[auth-sync] Watching ${filePath} for changes`);
    } catch (error) {
      console.error(`[auth-sync] Failed to watch ${filePath}:`, error);
    }
  }

  private async handleFileChange(
    provider: string,
    filePath: string,
  ): Promise<void> {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const hash = computeHash(content);
      const currentState = this.states.get(provider);

      if (currentState && currentState.hash === hash) {
        return;
      }

      console.log(`[auth-sync] Detected change in ${provider} auth`);
      await this.pushToManager(provider, content);
    } catch (error) {
      console.error(
        `[auth-sync] Error handling file change for ${provider}:`,
        error,
      );
    }
  }

  private async pullFromManager(
    provider: string,
    filePath: string,
  ): Promise<void> {
    try {
      const response = await fetch(`${MANAGER_INTERNAL_URL}/auth/${provider}`);

      if (!response.ok) {
        console.error(
          `[auth-sync] Failed to pull ${provider} auth: ${response.status}`,
        );
        return;
      }

      const data = (await response.json()) as {
        content: string | null;
        updatedAt?: string;
      };

      if (!data.content) {
        console.log(`[auth-sync] No existing auth for ${provider} on server`);

        if (fs.existsSync(filePath)) {
          const localContent = fs.readFileSync(filePath, "utf-8");
          await this.pushToManager(provider, localContent);
        }
        return;
      }

      const serverHash = computeHash(data.content);
      const currentState = this.states.get(provider);

      if (currentState && currentState.hash === serverHash) {
        return;
      }

      fs.writeFileSync(filePath, data.content, "utf-8");

      this.states.set(provider, {
        content: data.content,
        hash: serverHash,
        updatedAt: data.updatedAt || new Date().toISOString(),
      });

      console.log(`[auth-sync] Pulled ${provider} auth from manager`);
    } catch (error) {
      console.error(`[auth-sync] Error pulling ${provider} auth:`, error);
    }
  }

  private async pushToManager(
    provider: string,
    content: string,
  ): Promise<void> {
    if (!this.sandboxId) return;

    try {
      const currentState = this.states.get(provider);

      const response = await fetch(
        `${MANAGER_INTERNAL_URL}/auth/${provider}/sync`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content,
            sandboxId: this.sandboxId,
            updatedAt: currentState?.updatedAt,
          }),
        },
      );

      if (!response.ok) {
        console.error(
          `[auth-sync] Failed to push ${provider} auth: ${response.status}`,
        );
        return;
      }

      const data = (await response.json()) as SyncResponse;

      if (data.action === "conflict") {
        console.log(
          `[auth-sync] Conflict for ${provider} - server has newer version, updating local`,
        );
        const filePath = AUTH_PROVIDERS.find((p) => p.name === provider)?.path;
        if (filePath) {
          fs.writeFileSync(filePath, data.content, "utf-8");
        }
      }

      this.states.set(provider, {
        content: data.content,
        hash: computeHash(data.content),
        updatedAt: data.updatedAt,
      });

      console.log(`[auth-sync] Pushed ${provider} auth to manager`);
    } catch (error) {
      console.error(`[auth-sync] Error pushing ${provider} auth:`, error);
    }
  }

  private async pullAll(): Promise<void> {
    for (const provider of AUTH_PROVIDERS) {
      await this.pullFromManager(provider.name, provider.path);
    }
  }
}

export const authSyncService = new AuthSyncService();
