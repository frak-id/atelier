/**
 * The HTTP shell (atelier-v2 §3.1): `/v1/* → runtime` (through control's
 * authn + enrichment), `/api/* → control CRUD`, `/sessions/* → sessions`,
 * `/mcp → same three`.
 */
import { cors } from "@elysiajs/cors";
import { swagger } from "@elysiajs/swagger";
import { Elysia } from "elysia";
import { SandboxError } from "../shared/errors.ts";
import { dashboardUrl, isProduction } from "../shared/lib/config.ts";
import { logger } from "../shared/lib/logger.ts";
import { createAuthRoutes } from "./auth.routes.ts";
import type { ServerContainer } from "./container.ts";
import { createControlRoutes } from "./control.routes.ts";
import { healthRoutes } from "./health.routes.ts";
import { createMcpRoutes } from "./mcp/index.ts";
import { createSessionsRoutes } from "./sessions.routes.ts";
import { createV1Routes } from "./v1.routes.ts";

export function createApp(container: ServerContainer) {
  return new Elysia()
    .use(cors({ origin: dashboardUrl, credentials: true }))
    .use(
      swagger({
        path: "/swagger",
        documentation: {
          info: {
            title: "Atelier v2 Server API",
            version: "0.1.0",
            description:
              "A headless sandbox runtime. /v1 is mechanism, /api is policy, " +
              "/sessions is the agent app-tier.",
          },
          tags: [
            { name: "health", description: "Health check" },
            {
              name: "v1",
              description: "Runtime: prebuild/boot/pause/resume/destroy",
            },
            {
              name: "api",
              description: "Control: identity, saved specs, secrets",
            },
            {
              name: "sessions",
              description: "Agent app-tier: ACP sessions, terminal",
            },
          ],
        },
      }),
    )
    .onError(({ code, error, set }) => {
      if (error instanceof SandboxError) {
        set.status = error.statusCode;
        return { error: error.code, message: error.message };
      }
      switch (code) {
        case "VALIDATION": {
          set.status = 400;
          return {
            error: "VALIDATION_ERROR",
            message:
              error instanceof Error ? error.message : "Validation failed",
          };
        }
        case "NOT_FOUND": {
          set.status = 404;
          return { error: "NOT_FOUND", message: "Endpoint not found" };
        }
        default: {
          const message =
            error instanceof Error ? error.message : String(error);
          logger.error({ code, error: message }, "Unhandled error");
          set.status = 500;
          return {
            error: "INTERNAL_ERROR",
            message: isProduction() ? "Internal server error" : message,
          };
        }
      }
    })
    .use(healthRoutes)
    .use(createAuthRoutes(container))
    .use(createV1Routes(container))
    .use(createControlRoutes(container))
    .use(createSessionsRoutes(container))
    .use(createMcpRoutes(container))
    .get("/", () => ({
      name: "Atelier Server (v2)",
      version: "0.1.0",
      docs: "/swagger",
    }));
}

export type App = ReturnType<typeof createApp>;
