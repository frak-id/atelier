import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { swagger } from "@elysiajs/swagger";
import { config } from "./lib/config.ts";
import { logger } from "./lib/logger.ts";
import { SandboxError } from "./lib/errors.ts";
import { healthRoutes } from "./routes/health.ts";
import { systemRoutes } from "./routes/system/index.ts";
import { sandboxRoutes } from "./routes/sandboxes/index.ts";
import { debugRoutes } from "./routes/debug/index.ts";

const app = new Elysia()
  .use(cors())
  .use(
    swagger({
      path: "/swagger",
      documentation: {
        info: {
          title: "Frak Sandbox Manager API",
          version: "0.1.0",
          description: "API for managing Firecracker-based sandbox environments",
        },
        tags: [
          { name: "health", description: "Health check endpoints" },
          { name: "sandboxes", description: "Sandbox lifecycle management" },
          { name: "system", description: "System statistics and maintenance" },
          { name: "debug", description: "Debug and diagnostic endpoints" },
        ],
      },
    })
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
      case "VALIDATION":
        set.status = 400;
        return {
          error: "VALIDATION_ERROR",
          message: error.message,
        };

      case "NOT_FOUND":
        set.status = 404;
        return {
          error: "NOT_FOUND",
          message: "Endpoint not found",
        };

      default:
        logger.error({ code, error }, "Unhandled error");
        set.status = 500;
        return {
          error: "INTERNAL_ERROR",
          message: config.isProduction() ? "Internal server error" : error.message,
        };
    }
  })
  .use(healthRoutes)
  .group("/api", (app) =>
    app
      .use(systemRoutes)
      .use(sandboxRoutes)
  )
  .use(debugRoutes)
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
      "Frak Sandbox Manager started"
    );
  }
);

export type App = typeof app;
