import { cors } from "@elysiajs/cors";
import { swagger } from "@elysiajs/swagger";
import { Elysia } from "elysia";
import { config } from "./lib/config.ts";
import { SandboxError } from "./lib/errors.ts";
import { logger } from "./lib/logger.ts";
import { appPaths } from "./lib/paths.ts";
import { githubAuthRoutes } from "./routes/auth/github.ts";
import { configRoutes } from "./routes/config/index.ts";
import { githubApiRoutes } from "./routes/github/index.ts";
import { healthRoutes } from "./routes/health.ts";
import { imageRoutes } from "./routes/images/index.ts";
import { sandboxRoutes } from "./routes/sandboxes/index.ts";
import { sourceRoutes } from "./routes/sources/index.ts";
import { systemRoutes } from "./routes/system/index.ts";
import { workspaceRoutes } from "./routes/workspaces/index.ts";
import { initDatabase } from "./state/database.ts";

logger.info({ dataDir: appPaths.data }, "Using data directory");
await initDatabase();
logger.info({ dbPath: appPaths.database }, "Database ready");

const app = new Elysia()
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
      .use(sourceRoutes)
      .use(configRoutes)
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
