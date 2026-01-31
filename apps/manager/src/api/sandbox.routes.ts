import { Elysia } from "elysia";
import {
  agentClient,
  agentOperations,
  sandboxDestroyer,
  sandboxLifecycle,
  sandboxService,
  sandboxSpawner,
  workspaceService,
} from "../container.ts";
import { CaddyService } from "../infrastructure/proxy/caddy.service.ts";
import { QueueService } from "../infrastructure/queue/index.ts";
import { StorageService } from "../infrastructure/storage/index.ts";
import {
  AgentHealthSchema,
  AgentMetricsSchema,
  AppPortListResponseSchema,
  AppPortSchema,
  BrowserStartResponseSchema,
  BrowserStatusResponseSchema,
  BrowserStopResponseSchema,
  CreateSandboxBodySchema,
  DevCommandListResponseSchema,
  DevCommandLogsQuerySchema,
  DevCommandLogsResponseSchema,
  DevCommandNameParamsSchema,
  DevCommandStartResponseSchema,
  DevCommandStopResponseSchema,
  ExecBodySchema,
  ExecResponseSchema,
  GitCommitBodySchema,
  GitCommitResponseSchema,
  GitDiffResponseSchema,
  GitPushBodySchema,
  GitPushResponseSchema,
  GitStatusResponseSchema,
  IdParamSchema,
  LogsParamsSchema,
  LogsQuerySchema,
  LogsResponseSchema,
  PromoteToPrebuildResponseSchema,
  RegisterAppBodySchema,
  ResizeStorageBodySchema,
  ResizeStorageResponseSchema,
  SandboxListQuerySchema,
  SandboxListResponseSchema,
  SandboxSchema,
  ServicesResponseSchema,
  SpawnJobSchema,
} from "../schemas/index.ts";
import { NotFoundError, ResourceExhaustedError } from "../shared/errors.ts";
import { config } from "../shared/lib/config.ts";
import { createChildLogger } from "../shared/lib/logger.ts";

const log = createChildLogger("sandbox-routes");

export const sandboxRoutes = new Elysia({ prefix: "/sandboxes" })
  .get(
    "/",
    ({ query }) => {
      let sandboxes = sandboxService.getAll();

      if (query.status) {
        sandboxes = sandboxes.filter((s) => s.status === query.status);
      }

      if (query.workspaceId) {
        sandboxes = sandboxes.filter(
          (s) => s.workspaceId === query.workspaceId,
        );
      }

      return sandboxes;
    },
    {
      query: SandboxListQuerySchema,
      response: SandboxListResponseSchema,
    },
  )
  .post(
    "/",
    async ({ body, set }) => {
      const activeCount =
        sandboxService.countByStatus("running") +
        sandboxService.countByStatus("creating");

      if (activeCount >= config.defaults.MAX_SANDBOXES) {
        throw new ResourceExhaustedError("sandboxes");
      }

      log.info({ body }, "Creating sandbox");

      const sandbox = await sandboxSpawner.spawn(body);
      set.status = 201;
      return sandbox;
    },
    {
      body: CreateSandboxBodySchema,
      response: SandboxSchema,
    },
  )
  .group("", (app) =>
    app
      .resolve(({ params }) => {
        const { id } = params as { id: string };
        const sandbox = sandboxService.getById(id);
        if (!sandbox) {
          throw new NotFoundError("Sandbox", id);
        }
        return { sandbox };
      })
      .get(
        "/:id",
        async ({ sandbox }) => {
          return sandbox;
        },
        {
          params: IdParamSchema,
          response: SandboxSchema,
        },
      )
      .delete(
        "/:id",
        async ({ params, set, sandbox: _sandbox }) => {
          log.info({ sandboxId: params.id }, "Deleting sandbox");
          await sandboxDestroyer.destroy(params.id);

          set.status = 204;
          return null;
        },
        {
          params: IdParamSchema,
        },
      )
      .post(
        "/:id/stop",
        async ({ params, sandbox: _sandbox }) => {
          log.info({ sandboxId: params.id }, "Stopping sandbox");
          return sandboxLifecycle.stop(params.id);
        },
        {
          params: IdParamSchema,
          response: SandboxSchema,
        },
      )
      .post(
        "/:id/start",
        async ({ params, sandbox: _sandbox }) => {
          log.info({ sandboxId: params.id }, "Starting sandbox");
          return sandboxLifecycle.start(params.id);
        },
        {
          params: IdParamSchema,
          response: SandboxSchema,
        },
      )
      .post(
        "/:id/restart",
        async ({ params, sandbox: _sandbox }) => {
          log.info({ sandboxId: params.id }, "Restarting sandbox");
          await sandboxLifecycle.stop(params.id);
          return sandboxLifecycle.start(params.id);
        },
        {
          params: IdParamSchema,
          response: SandboxSchema,
        },
      )
      .get(
        "/:id/health",
        async ({ sandbox }) => {
          return agentClient.health(sandbox.id);
        },
        {
          params: IdParamSchema,
          response: AgentHealthSchema,
        },
      )
      .get(
        "/:id/metrics",
        async ({ sandbox }) => {
          return agentClient.metrics(sandbox.id);
        },
        {
          params: IdParamSchema,
          response: AgentMetricsSchema,
        },
      )
      .get(
        "/:id/apps",
        async ({ sandbox }) => {
          return agentClient.getApps(sandbox.id);
        },
        {
          params: IdParamSchema,
          response: AppPortListResponseSchema,
        },
      )
      .post(
        "/:id/apps",
        async ({ body, sandbox }) => {
          return agentClient.registerApp(sandbox.id, body.port, body.name);
        },
        {
          params: IdParamSchema,
          body: RegisterAppBodySchema,
          response: AppPortSchema,
        },
      )
      .post(
        "/:id/exec",
        async ({ body, sandbox }) => {
          return agentClient.exec(sandbox.id, body.command, {
            timeout: body.timeout,
          });
        },
        {
          params: IdParamSchema,
          body: ExecBodySchema,
          response: ExecResponseSchema,
        },
      )
      .get(
        "/:id/logs/:service",
        async ({ params, query, sandbox }) => {
          const lines = query.lines ? Number.parseInt(query.lines, 10) : 100;
          const result = await agentOperations.logs(
            sandbox.id,
            params.service,
            lines,
          );
          return { logs: result.content };
        },
        {
          params: LogsParamsSchema,
          query: LogsQuerySchema,
          response: LogsResponseSchema,
        },
      )
      .get(
        "/:id/services",
        async ({ sandbox }) => {
          return agentOperations.services(sandbox.id);
        },
        {
          params: IdParamSchema,
          response: ServicesResponseSchema,
        },
      )
      .get(
        "/:id/git/status",
        async ({ sandbox }) => {
          const workspace = sandbox.workspaceId
            ? workspaceService.getById(sandbox.workspaceId)
            : undefined;
          const repos = workspace?.config.repos ?? [];
          return agentOperations.gitStatus(sandbox.id, repos);
        },
        {
          params: IdParamSchema,
          response: GitStatusResponseSchema,
        },
      )
      .get(
        "/:id/git/diff",
        async ({ sandbox }) => {
          const workspace = sandbox.workspaceId
            ? workspaceService.getById(sandbox.workspaceId)
            : undefined;
          const repos = workspace?.config.repos ?? [];
          return agentOperations.gitDiffStat(sandbox.id, repos);
        },
        {
          params: IdParamSchema,
          response: GitDiffResponseSchema,
        },
      )
      .post(
        "/:id/git/commit",
        async ({ body, sandbox }) => {
          const workspace = sandbox.workspaceId
            ? workspaceService.getById(sandbox.workspaceId)
            : undefined;
          const repos = workspace?.config.repos ?? [];
          const repoExists = repos.some((r) => r.clonePath === body.repoPath);
          if (!repoExists) {
            return {
              path: body.repoPath,
              success: false,
              error: `Repository path not found in workspace: ${body.repoPath}`,
            };
          }
          return agentOperations.gitCommit(
            sandbox.id,
            body.repoPath,
            body.message,
          );
        },
        {
          params: IdParamSchema,
          body: GitCommitBodySchema,
          response: GitCommitResponseSchema,
        },
      )
      .post(
        "/:id/git/push",
        async ({ body, sandbox }) => {
          const workspace = sandbox.workspaceId
            ? workspaceService.getById(sandbox.workspaceId)
            : undefined;
          const repos = workspace?.config.repos ?? [];
          const repoExists = repos.some((r) => r.clonePath === body.repoPath);
          if (!repoExists) {
            return {
              path: body.repoPath,
              success: false,
              error: `Repository path not found in workspace: ${body.repoPath}`,
            };
          }
          return agentOperations.gitPush(sandbox.id, body.repoPath);
        },
        {
          params: IdParamSchema,
          body: GitPushBodySchema,
          response: GitPushResponseSchema,
        },
      )
      .post(
        "/:id/storage/resize",
        async ({ params, body, sandbox }) => {
          if (sandbox.status !== "running") {
            return {
              success: false,
              previousSize: 0,
              newSize: 0,
              error: "Sandbox must be running to resize storage",
            };
          }

          log.info(
            { sandboxId: params.id, sizeGb: body.sizeGb },
            "Resizing sandbox storage",
          );

          const lvResult = await StorageService.resizeSandboxVolume(
            params.id,
            body.sizeGb,
          );

          if (!lvResult.success) {
            return lvResult;
          }

          const agentResult = await agentOperations.resizeStorage(sandbox.id);

          if (!agentResult.success) {
            return {
              ...lvResult,
              success: false,
              error: `Volume extended but filesystem resize failed: ${agentResult.error}`,
            };
          }

          return {
            ...lvResult,
            disk: agentResult.disk,
          };
        },
        {
          params: IdParamSchema,
          body: ResizeStorageBodySchema,
          response: ResizeStorageResponseSchema,
        },
      )
      .post(
        "/:id/promote",
        async ({ params, sandbox }) => {
          if (sandbox.status !== "running") {
            throw new Error("Sandbox must be running to save as prebuild");
          }

          if (!sandbox.workspaceId) {
            throw new Error(
              "Sandbox must belong to a workspace to save as prebuild",
            );
          }

          const workspace = workspaceService.getById(sandbox.workspaceId);
          if (!workspace) {
            throw new NotFoundError("Workspace", sandbox.workspaceId);
          }

          log.info(
            { sandboxId: params.id, workspaceId: sandbox.workspaceId },
            "Promoting sandbox to prebuild",
          );

          await agentClient.exec(sandbox.id, "sync");
          await sandboxLifecycle.stop(params.id);
          await StorageService.createPrebuild(sandbox.workspaceId, params.id);
          await sandboxLifecycle.start(params.id);

          workspaceService.update(sandbox.workspaceId, {
            config: {
              ...workspace.config,
              prebuild: {
                status: "ready",
                latestId: params.id,
                builtAt: new Date().toISOString(),
              },
            },
          });

          log.info(
            { sandboxId: params.id, workspaceId: sandbox.workspaceId },
            "Sandbox promoted to prebuild successfully",
          );

          return {
            success: true,
            message: "Sandbox saved as prebuild successfully",
            workspaceId: sandbox.workspaceId,
          };
        },
        {
          params: IdParamSchema,
          response: PromoteToPrebuildResponseSchema,
        },
      )
      .get(
        "/:id/dev",
        async ({ sandbox }) => {
          const workspace = sandbox.workspaceId
            ? workspaceService.getById(sandbox.workspaceId)
            : undefined;
          const configuredCommands = workspace?.config.devCommands ?? [];

          const runtimeStatus = await agentClient.devList(sandbox.id);

          return {
            commands: configuredCommands.map((cmd) => {
              const runtime = runtimeStatus.commands.find(
                (r) => r.name === cmd.name,
              );
              const isRunning = runtime?.status === "running";

              let devUrl: string | undefined;
              let defaultDevUrl: string | undefined;
              let extraDevUrls:
                | Array<{ alias: string; port: number; url: string }>
                | undefined;

              if (isRunning && cmd.port) {
                devUrl = `https://dev-${cmd.name}-${sandbox.id}.${config.caddy.domainSuffix}`;
                if (cmd.isDefault) {
                  defaultDevUrl = `https://dev-${sandbox.id}.${config.caddy.domainSuffix}`;
                }
              }

              if (isRunning && cmd.extraPorts?.length) {
                extraDevUrls = cmd.extraPorts.map((ep) => ({
                  alias: ep.alias,
                  port: ep.port,
                  url: `https://dev-${cmd.name}-${ep.alias}-${sandbox.id}.${config.caddy.domainSuffix}`,
                }));
              }

              return {
                ...cmd,
                status: runtime?.status ?? "stopped",
                pid: runtime?.pid,
                startedAt: runtime?.startedAt,
                exitCode: runtime?.exitCode,
                devUrl,
                defaultDevUrl,
                extraDevUrls,
              };
            }),
          };
        },
        {
          params: IdParamSchema,
          response: DevCommandListResponseSchema,
        },
      )
      .post(
        "/:id/dev/:name/start",
        async ({ params, sandbox }) => {
          const workspace = sandbox.workspaceId
            ? workspaceService.getById(sandbox.workspaceId)
            : undefined;
          const devCommand = workspace?.config.devCommands?.find(
            (c) => c.name === params.name,
          );
          if (!devCommand) throw new NotFoundError("DevCommand", params.name);

          const result = await agentClient.devStart(
            sandbox.id,
            params.name,
            devCommand,
          );

          let devUrl: string | undefined;
          let defaultDevUrl: string | undefined;
          let extraDevUrls:
            | Array<{ alias: string; port: number; url: string }>
            | undefined;

          if (devCommand.port) {
            try {
              const urls = await CaddyService.registerDevRoute(
                sandbox.id,
                sandbox.runtime.ipAddress,
                params.name,
                devCommand.port,
                devCommand.isDefault ?? false,
                devCommand.extraPorts,
              );
              devUrl = urls.namedUrl;
              defaultDevUrl = urls.defaultUrl;
              extraDevUrls = urls.extraDevUrls;
            } catch (err) {
              log.warn(
                { sandboxId: sandbox.id, name: params.name, error: err },
                "Failed to register dev route",
              );
            }
          }

          return {
            ...result,
            devUrl,
            defaultDevUrl,
            extraDevUrls,
          };
        },
        {
          params: DevCommandNameParamsSchema,
          response: DevCommandStartResponseSchema,
        },
      )
      .post(
        "/:id/dev/:name/stop",
        async ({ params, sandbox }) => {
          const workspace = sandbox.workspaceId
            ? workspaceService.getById(sandbox.workspaceId)
            : undefined;
          const devCommand = workspace?.config.devCommands?.find(
            (c) => c.name === params.name,
          );

          const result = await agentClient.devStop(sandbox.id, params.name);

          if (devCommand?.port) {
            try {
              await CaddyService.removeDevRoute(
                sandbox.id,
                params.name,
                devCommand.isDefault ?? false,
                devCommand.extraPorts,
              );
            } catch (err) {
              log.warn(
                { sandboxId: sandbox.id, name: params.name, error: err },
                "Failed to remove dev route",
              );
            }
          }

          return result;
        },
        {
          params: DevCommandNameParamsSchema,
          response: DevCommandStopResponseSchema,
        },
      )
      .get(
        "/:id/dev/:name/logs",
        async ({ params, query, sandbox }) => {
          const offset = query.offset ? Number.parseInt(query.offset, 10) : 0;
          const limit = query.limit ? Number.parseInt(query.limit, 10) : 10000;

          return agentClient.devLogs(sandbox.id, params.name, offset, limit);
        },
        {
          params: DevCommandNameParamsSchema,
          query: DevCommandLogsQuerySchema,
          response: DevCommandLogsResponseSchema,
        },
      )
      .post(
        "/:id/browser/start",
        async ({ sandbox }) => {
          if (sandbox.status !== "running") {
            return { status: "off" as const };
          }

          const health = await agentClient.health(sandbox.id);
          const services = health.services as Record<string, boolean>;
          if (services.browser) {
            const browserUrl = sandbox.runtime.urls.browser;
            return { status: "running" as const, url: browserUrl };
          }

          const browserPort = config.raw.services.browser.port;

          const workspace = sandbox.workspaceId
            ? workspaceService.getById(sandbox.workspaceId)
            : undefined;
          const devCommands = workspace?.config.devCommands ?? [];
          const defaultDevCommand =
            devCommands.find((c) => c.isDefault) ?? devCommands[0];
          const defaultUrl = defaultDevCommand?.port
            ? `http://localhost:${defaultDevCommand.port}`
            : "about:blank";

          const browserCmd = [
            `(setsid Xvfb :99 -screen 0 1280x900x24 > /var/log/sandbox/xvfb.log 2>&1 &)`,
            `sleep 0.3`,
            `(setsid su - dev -c "DISPLAY=:99 chromium --no-sandbox --disable-gpu --disable-software-rasterizer --disable-dev-shm-usage --window-size=1280,900 --start-maximized '${defaultUrl}'" > /var/log/sandbox/chromium.log 2>&1 &)`,
            `sleep 0.5`,
            `(setsid x11vnc -display :99 -forever -shared -nopw -rfbport 5900 > /var/log/sandbox/x11vnc.log 2>&1 &)`,
            `sleep 0.2`,
            `(setsid websockify --web /opt/novnc ${browserPort} localhost:5900 > /var/log/sandbox/novnc.log 2>&1 &)`,
          ].join("\n");

          agentClient
            .exec(sandbox.id, browserCmd, { timeout: 10000 })
            .catch((err) => {
              log.warn(
                { sandboxId: sandbox.id, error: String(err) },
                "Browser start exec failed",
              );
            });

          const browserUrl = await CaddyService.registerBrowserRoute(
            sandbox.id,
            sandbox.runtime.ipAddress,
            browserPort,
          );

          sandboxService.update(sandbox.id, {
            runtime: {
              ...sandbox.runtime,
              urls: { ...sandbox.runtime.urls, browser: browserUrl },
            },
          });

          return { status: "starting" as const, url: browserUrl };
        },
        {
          params: IdParamSchema,
          response: BrowserStartResponseSchema,
        },
      )
      .get(
        "/:id/browser/status",
        async ({ sandbox }) => {
          if (sandbox.status !== "running") {
            return { status: "off" as const };
          }

          const browserUrl = sandbox.runtime.urls.browser;
          if (!browserUrl) {
            return { status: "off" as const };
          }

          try {
            const health = await agentClient.health(sandbox.id);
            const services = health.services as Record<string, boolean>;
            if (services.browser) {
              return { status: "running" as const, url: browserUrl };
            }
            return { status: "starting" as const, url: browserUrl };
          } catch {
            return { status: "off" as const };
          }
        },
        {
          params: IdParamSchema,
          response: BrowserStatusResponseSchema,
        },
      )
      .post(
        "/:id/browser/stop",
        async ({ sandbox }) => {
          if (sandbox.status !== "running") {
            return { status: "off" as const };
          }

          const killCmd = [
            "pkill -f websockify || true",
            "pkill -f x11vnc || true",
            "pkill -f chrome || true",
            "pkill -f chromium || true",
            "pkill -f Xvfb || true",
          ].join("\n");

          agentClient
            .exec(sandbox.id, killCmd, { timeout: 5000 })
            .catch((err) => {
              log.warn(
                { sandboxId: sandbox.id, error: String(err) },
                "Browser stop exec failed",
              );
            });

          await CaddyService.removeBrowserRoute(sandbox.id);

          sandboxService.update(sandbox.id, {
            runtime: {
              ...sandbox.runtime,
              urls: { ...sandbox.runtime.urls, browser: undefined },
            },
          });

          return { status: "off" as const };
        },
        {
          params: IdParamSchema,
          response: BrowserStopResponseSchema,
        },
      ),
  )
  .get(
    "/job/:id",
    ({ params }) => {
      const job = QueueService.getJob(params.id);
      if (!job) {
        throw new NotFoundError("Job", params.id);
      }
      return job;
    },
    {
      params: IdParamSchema,
      response: SpawnJobSchema,
    },
  );
