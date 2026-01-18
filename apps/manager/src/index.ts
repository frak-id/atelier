import { cors } from "@elysiajs/cors";
import { swagger } from "@elysiajs/swagger";
import { Elysia } from "elysia";
import { setAgentSandboxStore } from "./infrastructure/agent/index.ts";
import { initDatabase } from "./infrastructure/database/index.ts";
import { CaddyService } from "./infrastructure/proxy/index.ts";
import {
  ConfigFileService,
  configFileRoutes,
} from "./modules/config-file/index.ts";
import {
  GitSourceService,
  gitSourceRoutes,
} from "./modules/git-source/index.ts";
import { githubApiRoutes, githubAuthRoutes } from "./modules/github/index.ts";
import { healthRoutes } from "./modules/health/index.ts";
import { imageRoutes } from "./modules/image/index.ts";
import {
  initPrebuildService,
  PrebuildService,
} from "./modules/prebuild/index.ts";
import {
  initSandboxService,
  SandboxService,
  sandboxRoutes,
} from "./modules/sandbox/index.ts";
import { systemRoutes } from "./modules/system/index.ts";
import {
  setPrebuildCreator,
  WorkspaceService,
  workspaceRoutes,
} from "./modules/workspace/index.ts";
import { SandboxError } from "./shared/errors.ts";
import { config } from "./shared/lib/config.ts";
import { logger } from "./shared/lib/logger.ts";
import { appPaths } from "./shared/lib/paths.ts";

logger.info({ dataDir: appPaths.data }, "Using data directory");
await initDatabase();
logger.info({ dbPath: appPaths.database }, "Database ready");

setAgentSandboxStore({
  getById: (id: string) => SandboxService.getById(id),
});

initSandboxService({
  getWorkspace: (id) => WorkspaceService.getById(id),
  getGitSource: (id) => GitSourceService.getById(id),
  getConfigFiles: (workspaceId) =>
    ConfigFileService.getMergedForSandbox(workspaceId),
});

initPrebuildService({
  getWorkspace: (id) => WorkspaceService.getById(id),
  updateWorkspace: (id, updates) => {
    try {
      return WorkspaceService.update(id, updates);
    } catch {
      return undefined;
    }
  },
  spawnSandbox: (options) => SandboxService.spawn(options),
  destroySandbox: (id) => SandboxService.destroy(id),
});

setPrebuildCreator((workspaceId) => {
  PrebuildService.createInBackground(workspaceId);
});

const app = new Elysia()
  .on("start", async () => {
    const sandboxes = SandboxService.getByStatus("running");

    for (const sandbox of sandboxes) {
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
      } catch (err) {
        logger.error(
          { sandboxId: sandbox.id, error: err },
          "Failed to re-register Caddy routes on startup",
        );
      }
    }

    if (sandboxes.length > 0) {
      logger.info(
        { count: sandboxes.length },
        "Startup reconciliation: Caddy routes re-registered",
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
  .group("/auth", (app) => app.use(githubAuthRoutes))
  .group("/api", (app) =>
    app
      .use(sandboxRoutes)
      .use(workspaceRoutes)
      .use(gitSourceRoutes)
      .use(configFileRoutes)
      .use(systemRoutes)
      .use(imageRoutes)
      .use(githubApiRoutes),
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
