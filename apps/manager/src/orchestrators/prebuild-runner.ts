import { VM } from "@frak/atelier-shared/constants";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import type { AgentClient } from "../infrastructure/agent/index.ts";
import { StorageService } from "../infrastructure/storage/index.ts";
import type { InternalService } from "../modules/internal/internal.service.ts";
import type { SandboxRepository } from "../modules/sandbox/index.ts";
import { config } from "../shared/lib/config.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import { buildOpenCodeAuthHeaders } from "../shared/lib/opencode-auth.ts";
import type { SandboxDestroyer } from "./sandbox-destroyer.ts";
import type { SandboxSpawner } from "./sandbox-spawner.ts";

const log = createChildLogger("prebuild-runner");

const WORKSPACE_DIR = VM.WORKSPACE_DIR;
const OPENCODE_HEALTH_TIMEOUT = 120000;

export interface PrebuildRunnerDependencies {
  sandboxSpawner: SandboxSpawner;
  sandboxDestroyer: SandboxDestroyer;
  sandboxService: SandboxRepository;
  agentClient: AgentClient;
  internalService: InternalService;
}

export abstract class PrebuildRunner {
  protected readonly activeBuilds = new Map<
    string,
    { abortController: AbortController; sandboxId?: string }
  >();

  constructor(protected readonly deps: PrebuildRunnerDependencies) {}

  protected throwIfAborted(key: string): void {
    const activeBuild = this.activeBuilds.get(key);
    if (activeBuild?.abortController.signal.aborted) {
      const error = new Error("Prebuild cancelled");
      error.name = "AbortError";
      throw error;
    }
  }

  async hasPrebuild(key: string): Promise<boolean> {
    return StorageService.hasPrebuild(key);
  }

  async cleanupStorage(key: string): Promise<void> {
    await StorageService.deletePrebuild(key);
  }

  protected async pushLatestAuthAndConfigs(sandboxId: string): Promise<void> {
    const result = await this.deps.internalService.syncToSandbox(sandboxId);
    log.info(
      {
        sandboxId,
        authSynced: result.auth.synced,
        configsSynced: result.configs.synced,
      },
      "Auth and configs baked into prebuild",
    );
  }

  protected async syncFilesystem(sandboxId: string): Promise<void> {
    await this.deps.agentClient.exec(sandboxId, "sync", { timeout: 5000 });
  }

  protected async warmupOpencode(
    sandboxId: string,
    prebuildKey: string,
    ipAddress: string,
    opencodePassword?: string,
  ): Promise<void> {
    log.info({ prebuildKey }, "Warming up opencode server");

    const port = config.advanced.vm.opencode.port;
    const startResult = await this.deps.agentClient.exec(
      sandboxId,
      `nohup setsid opencode serve --hostname 0.0.0.0 --port ${port} </dev/null >/tmp/opencode-warmup.log 2>&1 &`,
      { timeout: 10000, user: "dev", workdir: WORKSPACE_DIR },
    );

    if (startResult.exitCode !== 0) {
      log.warn(
        { prebuildKey, stderr: startResult.stderr },
        "Failed to start opencode for warmup, continuing anyway",
      );
      return;
    }

    const url = `http://${ipAddress}:${port}`;
    const startTime = Date.now();
    let healthy = false;

    while (Date.now() - startTime < OPENCODE_HEALTH_TIMEOUT) {
      try {
        const client = createOpencodeClient({
          baseUrl: url,
          headers: buildOpenCodeAuthHeaders(opencodePassword),
        });
        const { data } = await client.global.health();
        if (data?.healthy) {
          healthy = true;
          log.info({ prebuildKey }, "Opencode server is healthy");
          break;
        }
      } catch {}

      await Bun.sleep(2000);
    }

    if (!healthy) {
      log.warn(
        { prebuildKey },
        "Opencode did not become healthy within timeout, continuing anyway",
      );
    }

    await this.deps.agentClient.exec(sandboxId, "pkill -f 'opencode serve'", {
      timeout: 5000,
    });

    log.info({ prebuildKey }, "Opencode warmup completed");
  }

  isBuilding(key: string): boolean {
    return this.activeBuilds.has(key);
  }
}
