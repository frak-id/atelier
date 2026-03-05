import { Elysia, t } from "elysia";
import { cliProxyService } from "../container.ts";

const CLIProxyStatusSchema = t.Object({
  enabled: t.Boolean(),
  configured: t.Boolean(),
  url: t.String(),
  lastRefresh: t.Nullable(t.String()),
  modelCount: t.Number(),
});

const CLIProxyToggleSchema = t.Object({
  enabled: t.Boolean(),
});

const CLIProxySettingsSchema = t.Object({
  enabled: t.Boolean(),
});

const CLIProxyRefreshResultSchema = t.Object({
  modelCount: t.Number(),
});

export const cliproxyRoutes = new Elysia({ prefix: "/cliproxy" })
  .get("/", () => cliProxyService.getStatus(), {
    detail: {
      tags: ["system"],
      summary: "Get CLIProxy auto-config status",
    },
    response: CLIProxyStatusSchema,
  })
  .put(
    "/",
    async ({ body }) => {
      cliProxyService.setEnabled(body.enabled);
      if (body.enabled) {
        await cliProxyService.refresh().catch(() => {});
      }
      return cliProxyService.getStatus();
    },
    {
      detail: {
        tags: ["system"],
        summary: "Toggle CLIProxy auto-config",
      },
      body: CLIProxyToggleSchema,
      response: CLIProxyStatusSchema,
    },
  )
  .get("/settings", () => cliProxyService.getSettings(), {
    detail: {
      tags: ["system"],
      summary: "Get CLIProxy settings",
    },
    response: CLIProxySettingsSchema,
  })
  .post("/refresh", () => cliProxyService.refresh(), {
    detail: {
      tags: ["system"],
      summary: "Manually refresh CLIProxy model config",
    },
    response: CLIProxyRefreshResultSchema,
  });
