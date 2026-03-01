import { cors } from "@elysiajs/cors";
import { swagger } from "@elysiajs/swagger";
import { validateConfig } from "@frak/atelier-shared";
import { Elysia } from "elysia";
import {
  authRoutes,
  configFileRoutes,
  eventsRoutes,
  githubApiRoutes,
  githubOAuthRoutes,
  gitSourceRoutes,
  healthRoutes,
  imageRoutes,
  integrationRoutes,
  internalWellKnownRoutes,
  publicConfigRoutes,
  registryRoutes,
  sandboxRoutes,
  sessionTemplateRoutes,
  sharedAuthRoutes,
  sharedStorageRoutes,
  sshKeyRoutes,
  systemModelConfigRoutes,
  systemRoutes,
  taskRoutes,
  workspaceRoutes,
} from "./api/index.ts";
import {
  agentOperations,
  authSyncService,
  prebuildChecker,
  prebuildRunner,
  sandboxLifecycle,
  sandboxService,
  sshKeyService,
  systemSandboxService,
  workspaceService,
} from "./container.ts";
import { CronService } from "./infrastructure/cron/index.ts";
import { initDatabase } from "./infrastructure/database/index.ts";
import { networkService } from "./infrastructure/network/index.ts";
import { sandboxPoller } from "./infrastructure/poller/index.ts";
import { proxyService, SshPiperService } from "./infrastructure/proxy/index.ts";
import { RegistryService } from "./infrastructure/registry/index.ts";
import { mcpRoutes } from "./mcp/index.ts";

import { SandboxError } from "./shared/errors.ts";
import { authGuard } from "./shared/lib/auth.ts";
import { config, dashboardUrl, isProduction } from "./shared/lib/config.ts";
import { logger } from "./shared/lib/logger.ts";
import { appPaths } from "./shared/lib/paths.ts";

const configErrors = validateConfig(config);
if (configErrors.length > 0 && isProduction()) {
  for (const err of configErrors) {
    logger.error({ field: err.field }, err.message);
  }
  logger.fatal("Configuration validation failed. Exiting.");
  process.exit(1);
} else if (configErrors.length > 0) {
  for (const err of configErrors) {
    logger.warn({ field: err.field }, `Config warning: ${err.message}`);
  }
}

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

    CronService.add("sandboxSelfHeal", {
      name: "Sandbox + Listener Self Heal",
      pattern: "*/1 * * * *",
      handler: async () => {
        const running = sandboxService.getByStatus("running");
        await Promise.allSettled(
          running.map((s) => sandboxLifecycle.getStatus(s.id)),
        );
        systemSandboxService.healIfNeeded();
      },
    });
    const expiredCount = sshKeyService.cleanupExpired();
    if (expiredCount > 0) {
      logger.info({ expiredCount }, "Startup: expired SSH keys cleaned up");
    }

    authSyncService.syncAuthToSandboxes().catch(() => {});
    authSyncService.startAuthWatcher();

    const allSandboxes = sandboxService.getAll();
    networkService.reconcile(allSandboxes.map((s) => s.runtime.ipAddress));
    if (allSandboxes.length > 0) {
      logger.info(
        {
          count: allSandboxes.length,
          allocatedIps: networkService.getAllocatedCount(),
        },
        "Startup: IP pool reconciled from DB",
      );
    }

    // Reconcile stale "creating" sandboxes from a previous crash
    const staleTtlMs = 10 * 60 * 1000;
    const now = Date.now();
    const staleSandboxes = allSandboxes.filter(
      (s) =>
        s.status === "creating" &&
        now - new Date(s.createdAt).getTime() > staleTtlMs,
    );
    for (const sandbox of staleSandboxes) {
      sandboxService.updateStatus(
        sandbox.id,
        "error",
        "Stale creating state after manager restart",
      );
      logger.warn(
        { sandboxId: sandbox.id, createdAt: sandbox.createdAt },
        "Startup: marked stale creating sandbox as error",
      );
    }

    // Reset prebuilds stuck in "building" state from a previous crash
    const allWorkspaces = workspaceService.getAll();
    for (const workspace of allWorkspaces) {
      if (workspace.config.prebuild?.status === "building") {
        workspaceService.update(workspace.id, {
          config: {
            prebuild: {
              ...workspace.config.prebuild,
              status: "failed",
            },
          },
        });
        logger.warn(
          { workspaceId: workspace.id, workspaceName: workspace.name },
          "Startup: reset stuck building prebuild to failed",
        );
      }
    }

    // Wait for Caddy to become ready before rehydrating routes
    const caddyDeadline = Date.now() + 30_000;
    let caddyReady = false;
    while (Date.now() < caddyDeadline) {
      if (await proxyService.isHealthy()) {
        caddyReady = true;
        break;
      }
      logger.warn("Startup: waiting for Caddy to become ready");
      await Bun.sleep(1000);
    }
    if (!caddyReady) {
      logger.error(
        "Startup: Caddy not ready after 30s — route rehydration may fail",
      );
    }
    const runningSandboxes = allSandboxes.filter((s) => s.status === "running");
    for (const sandbox of runningSandboxes) {
      try {
        await proxyService.registerRoutes(
          sandbox.id,
          sandbox.runtime.ipAddress,
          {
            vscode: config.advanced.vm.vscode.port,
            opencode: config.advanced.vm.opencode.port,
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

    await RegistryService.initialize();
  })
  .use(
    cors({
      origin: dashboardUrl,
      credentials: true,
    }),
  )
  .use(
    swagger({
      path: "/swagger",
      documentation: {
        info: {
          title: "L'atelier Manager API",
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
            description: "Shared storage management (binaries)",
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
          message: isProduction() ? "Internal server error" : errorMessage,
        };
      }
    }
  })
  .use(healthRoutes)
  .use(publicConfigRoutes)
  .use(internalWellKnownRoutes)
  .use(authRoutes)
  .use(mcpRoutes)
  .use(integrationRoutes)
  .group("/api", (app) =>
    app
      .use(githubOAuthRoutes)
      .guard({ beforeHandle: authGuard }, (app) =>
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
          .use(registryRoutes)
          .use(imageRoutes)
          .use(githubApiRoutes)
          .use(eventsRoutes)
          .use(systemModelConfigRoutes),
      ),
  )
  .get("/", () => ({
    name: "L'atelier Manager",
    version: "0.1.0",
    mode: config.server.mode,
    docs: "/swagger",
  }));

await systemSandboxService.recoverFromRestart();

setImmediate(() => {
  prebuildRunner.ensureSystemPrebuild().catch((error) => {
    logger.warn({ error }, "System prebuild auto-build failed");
  });
});

app.listen(
  {
    port: config.server.port,
    hostname: config.server.host,
  },
  ({ hostname, port }) => {
    logger.info(
      {
        hostname,
        port,
        mode: config.server.mode,
        swagger: `http://${hostname}:${port}/swagger`,
      },
      "L'atelier Manager started",
    );
  },
);

sandboxPoller.start({
  agentOperations,
  getSandboxes: () => sandboxService.getAll(),
  getWorkspaceRepos: (workspaceId) => {
    const ws = workspaceService.getById(workspaceId);
    return ws?.config.repos ?? [];
  },
});

export type App = typeof app;
