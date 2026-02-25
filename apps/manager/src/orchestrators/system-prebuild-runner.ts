import { PATHS } from "@frak/atelier-shared/constants";
import { StorageService } from "../infrastructure/storage/index.ts";
import { SYSTEM_WORKSPACE_ID } from "../modules/system-sandbox/index.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import { ensureDir } from "../shared/lib/shell.ts";
import {
  PrebuildRunner,
  type PrebuildRunnerDependencies,
} from "./prebuild-runner.ts";

const log = createChildLogger("system-prebuild-runner");

export class SystemPrebuildRunner extends PrebuildRunner {
  constructor(protected override readonly deps: PrebuildRunnerDependencies) {
    super(deps);
  }

  private get metadataPath(): string {
    return `${PATHS.SANDBOX_DIR}/system-prebuild.json`;
  }

  private async writeMetadata(latestId: string): Promise<void> {
    await ensureDir(PATHS.SANDBOX_DIR);
    await Bun.write(
      this.metadataPath,
      JSON.stringify(
        {
          latestId,
          builtAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  }

  async readMetadata(): Promise<{ latestId: string; builtAt: string } | null> {
    try {
      const file = Bun.file(this.metadataPath);
      if (!(await file.exists())) return null;
      return (await file.json()) as { latestId: string; builtAt: string };
    } catch {
      return null;
    }
  }

  async run(): Promise<void> {
    const key = SYSTEM_WORKSPACE_ID;
    if (this.activeBuilds.has(key)) {
      throw new Error("System prebuild already in progress");
    }

    const abortController = new AbortController();
    this.activeBuilds.set(key, { abortController });

    log.info("Starting system sandbox prebuild");

    if (await StorageService.hasPrebuild(key)) {
      await StorageService.deletePrebuild(key);
      await this.deleteVmSnapshot(key);
      log.info("Deleted existing system prebuild before regeneration");
    }

    let sandboxId: string | undefined;

    try {
      this.throwIfAborted(key);

      const sandbox = await this.deps.sandboxSpawner.spawn({
        workspaceId: key,
        system: true,
        vcpus: 1,
        memoryMb: 1024,
      });

      sandboxId = sandbox.id;
      const activeBuild = this.activeBuilds.get(key);
      if (activeBuild) activeBuild.sandboxId = sandboxId;

      log.info(
        { prebuildSandboxId: sandbox.id },
        "System prebuild sandbox spawned",
      );

      this.throwIfAborted(key);
      const agentReady = await this.deps.agentClient.waitForAgent(sandbox.id, {
        timeout: 60000,
      });
      if (!agentReady) throw new Error("Agent failed to become ready");

      this.throwIfAborted(key);
      await this.warmupOpencode(
        sandbox.id,
        key,
        sandbox.runtime.ipAddress,
        sandbox.runtime.opencodePassword,
      );

      this.throwIfAborted(key);
      await this.pushLatestAuthAndConfigs(sandbox.id);
      await this.prepareForSnapshot(sandbox.id);
      await this.createVmSnapshot(key, sandbox.id);
      await StorageService.createPrebuild(key, sandbox.id);
      await this.writeMetadata(sandbox.id);

      log.info({ sandboxId: sandbox.id }, "System prebuild snapshot created");

      await this.deps.sandboxDestroyer.destroy(sandbox.id);
      log.info("System prebuild completed successfully");
    } catch (error) {
      const isCancelled = error instanceof Error && error.name === "AbortError";
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      if (isCancelled) {
        log.info("System prebuild cancelled");
      } else {
        log.error({ error: errorMessage }, "System prebuild failed");
      }

      if (sandboxId) {
        await this.deps.sandboxDestroyer.destroy(sandboxId).catch((e) => {
          log.warn(
            { sandboxId, error: e },
            "Failed to cleanup system prebuild sandbox",
          );
        });
      }

      try {
        await this.deleteVmSnapshot(key);
      } catch (cleanupError) {
        log.warn(
          { error: cleanupError },
          "Failed to cleanup partial system VM snapshot",
        );
      }

      if (!isCancelled) throw error;
    } finally {
      this.activeBuilds.delete(key);
    }
  }

  runInBackground(): void {
    setImmediate(() => {
      this.run().catch((error) => {
        log.error({ error }, "Background system prebuild failed");
      });
    });
  }

  async cancel(): Promise<void> {
    const key = SYSTEM_WORKSPACE_ID;
    const activeBuild = this.activeBuilds.get(key);

    if (activeBuild) {
      log.info("Cancelling active system prebuild");
      activeBuild.abortController.abort();
      return;
    }

    if (!this.isBuilding()) {
      throw new Error("No system prebuild in progress to cancel");
    }
  }

  async delete(): Promise<void> {
    const key = SYSTEM_WORKSPACE_ID;
    await this.cleanupStorage(key);

    try {
      const file = Bun.file(this.metadataPath);
      if (await file.exists()) {
        const { unlink } = await import("node:fs/promises");
        await unlink(this.metadataPath);
      }
    } catch (e) {
      log.warn({ error: e }, "Failed to remove system prebuild metadata");
    }

    log.info("System prebuild deleted");
  }

  async ensurePrebuild(): Promise<void> {
    const key = SYSTEM_WORKSPACE_ID;
    const hasLvm = await StorageService.hasPrebuild(key);
    const hasVm = await this.hasVmSnapshot(key);
    if (hasLvm && hasVm) {
      log.info("System prebuild already exists, skipping");
      return;
    }
    await this.run();
  }

  override isBuilding(): boolean {
    return this.activeBuilds.has(SYSTEM_WORKSPACE_ID);
  }

  getStatus(): { hasPrebuild: boolean; building: boolean } {
    return {
      hasPrebuild: false,
      building: this.activeBuilds.has(SYSTEM_WORKSPACE_ID),
    };
  }
}
