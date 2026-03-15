import { Elysia, t } from "elysia";
import { cliProxyService, kubeClient } from "../container.ts";
import { authPlugin } from "../shared/lib/auth.ts";
import { config } from "../shared/lib/config.ts";

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

const CLIProxyModelUsageSchema = t.Object({
  model: t.String(),
  requests: t.Number(),
  tokens: t.Number(),
});

const CLIProxySandboxUsageSchema = t.Object({
  totalRequests: t.Number(),
  totalTokens: t.Number(),
  models: t.Array(CLIProxyModelUsageSchema),
});

const CLIProxyDeveloperUsageSchema = t.Object({
  username: t.String(),
  totalRequests: t.Number(),
  totalTokens: t.Number(),
  models: t.Array(CLIProxyModelUsageSchema),
});

const CLIProxyUsageSchema = t.Object({
  global: t.Object({
    totalRequests: t.Number(),
    successCount: t.Number(),
    failureCount: t.Number(),
    totalTokens: t.Number(),
    models: t.Array(CLIProxyModelUsageSchema),
    today: t.Nullable(
      t.Object({
        requests: t.Number(),
        tokens: t.Number(),
      }),
    ),
  }),
  sandboxes: t.Record(t.String(), CLIProxySandboxUsageSchema),
  developers: t.Array(CLIProxyDeveloperUsageSchema),
});

export const cliproxyRoutes = new Elysia({ prefix: "/cliproxy" })
  .use(authPlugin)
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
  })
  .get("/export", () => cliProxyService.getExportableConfig(), {
    detail: {
      tags: ["system"],
      summary: "Get exportable OpenCode provider config with external URL",
    },
  })
  .post(
    "/restart",
    async () => {
      const result = await kubeClient.restartDeployment(
        "app.kubernetes.io/component=cliproxy",
        config.kubernetes.systemNamespace,
      );
      return { message: "CLIProxy restart triggered", name: result.name };
    },
    {
      response: t.Object({
        message: t.String(),
        name: t.String(),
      }),
      detail: {
        tags: ["system"],
        summary: "Rollout restart CLIProxy deployment",
      },
    },
  )
  .get(
    "/user-api-key",
    async ({ user }) => {
      const existing = cliProxyService.getUserApiKey(user.username);
      const apiKey =
        existing ?? (await cliProxyService.createUserKey(user.username));
      return { apiKey };
    },
    {
      detail: {
        tags: ["cliproxy"],
        summary: "Get current user's CLIProxy API key",
      },
      response: t.Object({
        apiKey: t.Nullable(t.String()),
      }),
    },
  )
  .post(
    "/user-api-key",
    async ({ user }) => {
      const apiKey = await cliProxyService.createUserKey(user.username);
      return { apiKey };
    },
    {
      detail: {
        tags: ["cliproxy"],
        summary: "Create CLIProxy API key for current user",
      },
      response: t.Object({
        apiKey: t.Nullable(t.String()),
      }),
    },
  )
  .get(
    "/usage",
    async ({ set }) => {
      const usage = await cliProxyService.getUsage();
      if (!usage) {
        set.status = 503;
        return null;
      }
      return usage;
    },
    {
      response: {
        200: CLIProxyUsageSchema,
        503: t.Null(),
      },
      detail: {
        tags: ["system"],
        summary: "Get CLIProxy token usage statistics",
      },
    },
  );
