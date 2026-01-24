import { cors } from "@elysiajs/cors";
import { swagger } from "@elysiajs/swagger";
import { Elysia } from "elysia";
import { prebuildChecker, sandboxService, sshKeyService } from "./container.ts";
import { CronService } from "./infrastructure/cron/index.ts";
import { initDatabase } from "./infrastructure/database/index.ts";
import { NetworkService } from "./infrastructure/network/index.ts";
import { CaddyService, SshPiperService } from "./infrastructure/proxy/index.ts";
import { authRoutes } from "./modules/auth/index.ts";
import { configFileRoutes } from "./modules/config-file/index.ts";
import { gitSourceRoutes } from "./modules/git-source/index.ts";
import { githubApiRoutes, githubAuthRoutes } from "./modules/github/index.ts";
import { healthRoutes } from "./modules/health/index.ts";
import { imageRoutes } from "./modules/image/index.ts";
import { internalRoutes } from "./modules/internal/index.ts";
import { sandboxRoutes } from "./modules/sandbox/index.ts";
import { sessionTemplateRoutes } from "./modules/session-template/index.ts";
import { sharedAuthRoutes } from "./modules/shared-auth/index.ts";
import { sharedStorageRoutes } from "./modules/shared-storage/index.ts";
import { sshKeyRoutes } from "./modules/ssh-key/index.ts";
import { systemRoutes } from "./modules/system/index.ts";
import { taskRoutes } from "./modules/task/index.ts";
import { workspaceRoutes } from "./modules/workspace/index.ts";
import { SandboxError } from "./shared/errors.ts";
import { authGuard } from "./shared/lib/auth.ts";
import { config } from "./shared/lib/config.ts";
import { internalGuard } from "./shared/lib/internal-guard.ts";
import { logger } from "./shared/lib/logger.ts";
import { appPaths } from "./shared/lib/paths.ts";

logger.info({ dataDir: appPaths.data }, "Using data directory");
await initDatabase();
logger.info({ dbPath: appPaths.database }, "Database ready");

const app = new Elysia()
  .on("start", async () => {
    CronService.add("prebuildStaleness", {
      name: "Prebuild Staleness Check",
      pattern: "*/30 * * * *",
      handler: () => prebuildChecker.checkAllAndRebuildStale(),
    });
    const expiredCount = sshKeyService.cleanupExpired();
    if (expiredCount > 0) {
      logger.info({ expiredCount }, "Startup: expired SSH keys cleaned up");
    }

    const allSandboxes = sandboxService.getAll();
    for (const sandbox of allSandboxes) {
      NetworkService.markAllocated(sandbox.runtime.ipAddress);
    }

    if (allSandboxes.length > 0) {
      logger.info(
        {
          count: allSandboxes.length,
          allocatedIps: NetworkService.getAllocatedCount(),
        },
        "Startup: IP allocations rehydrated",
      );
    }

    const runningSandboxes = allSandboxes.filter((s) => s.status === "running");
    for (const sandbox of runningSandboxes) {
      try {
        await CaddyService.registerRoutes(
          sandbox.id,
          sandbox.runtime.ipAddress,
          {
            vscode: 8080,
            opencode: 3000,
            terminal: 7681,
          },
        );
        await SshPiperService.registerRoute(
          sandbox.id,
          sandbox.runtime.ipAddress,
        );
      } catch (err) {
        logger.error(
          { sandboxId: sandbox.id, error: err },
          "Failed to re-register routes",
        );
      }
    }

    const validKeys = sshKeyService.getValidPublicKeys();
    if (validKeys.length > 0) {
      await SshPiperService.updateAuthorizedKeys(validKeys);
    }

    if (runningSandboxes.length > 0) {
      logger.info(
        { count: runningSandboxes.length },
        "Startup: routes re-registered",
      );
    }
  })
  .use(cors())
  .use(
    swagger({
      path: "/swagger",
      documentation: {
        info: {
          title: "Frak Sandbox Manager API",
          version: "0.1.0",
          description:
            "API for managing Firecracker-based sandbox environments",
        },
        tags: [
          { name: "health", description: "Health check endpoints" },
          { name: "sandboxes", description: "Sandbox lifecycle management" },
          { name: "workspaces", description: "Workspace configuration" },
          { name: "sources", description: "Git source connections" },
          { name: "config", description: "Config file management" },
          { name: "system", description: "System monitoring and management" },
          {
            name: "storage",
            description: "Shared storage management (NFS, binaries, cache)",
          },
          { name: "images", description: "Base image management" },
          { name: "github", description: "GitHub integration" },
        ],
      },
    }),
  )
  .onError(({ code, error, set }) => {
    if (error instanceof SandboxError) {
      set.status = error.statusCode;
      return {
        error: error.code,
        message: error.message,
      };
    }

    switch (code) {
      case "VALIDATION": {
        const validationMessage =
          error instanceof Error ? error.message : "Validation failed";
        set.status = 400;
        return {
          error: "VALIDATION_ERROR",
          message: validationMessage,
        };
      }

      case "NOT_FOUND":
        set.status = 404;
        return {
          error: "NOT_FOUND",
          message: "Endpoint not found",
        };

      default: {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        logger.error({ code, error: errorMessage }, "Unhandled error");
        set.status = 500;
        return {
          error: "INTERNAL_ERROR",
          message: config.isProduction()
            ? "Internal server error"
            : errorMessage,
        };
      }
    }
  })
  .use(healthRoutes)
  .use(authRoutes)
  .guard({ beforeHandle: internalGuard }, (app) => app.use(internalRoutes))
  .group("/auth", (app) =>
    app.guard({ beforeHandle: authGuard }, (app) => app.use(githubAuthRoutes)),
  )
  .group("/api", (app) =>
    app.guard({ beforeHandle: authGuard }, (app) =>
      app
        .use(sandboxRoutes)
        .use(workspaceRoutes)
        .use(taskRoutes)
        .use(sessionTemplateRoutes)
        .use(gitSourceRoutes)
        .use(configFileRoutes)
        .use(sharedAuthRoutes)
        .use(sshKeyRoutes)
        .use(systemRoutes)
        .use(sharedStorageRoutes)
        .use(imageRoutes)
        .use(githubApiRoutes),
    ),
  )
  .get("/", () => ({
    name: "Frak Sandbox Manager",
    version: "0.1.0",
    mode: config.mode,
    docs: "/swagger",
  }));

app.listen(
  {
    port: config.port,
    hostname: config.host,
  },
  ({ hostname, port }) => {
    logger.info(
      {
        hostname,
        port,
        mode: config.mode,
        swagger: `http://${hostname}:${port}/swagger`,
      },
      "Frak Sandbox Manager started",
    );
  },
);

export type App = typeof app;
