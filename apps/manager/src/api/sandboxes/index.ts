import { Elysia } from "elysia";
import {
  agentClient,
  agentOperations,
  sandboxDestroyer,
  sandboxLifecycle,
  sandboxService,
  sandboxSpawner,
  workspaceService,
} from "../../container.ts";
import { internalBus } from "../../infrastructure/events/internal-bus.ts";
import { CaddyService } from "../../infrastructure/proxy/caddy.service.ts";
import { StorageService } from "../../infrastructure/storage/index.ts";
import {
  AgentHealthSchema,
  AgentMetricsSchema,
  BrowserStartResponseSchema,
  BrowserStopResponseSchema,
  CreateSandboxBodySchema,
  CreateSandboxResponseSchema,
  GitCommitBodySchema,
  GitCommitResponseSchema,
  GitDiffResponseSchema,
  GitPushBodySchema,
  GitPushResponseSchema,
  GitStatusResponseSchema,
  IdParamSchema,
  PromoteToPrebuildResponseSchema,
  ResizeStorageBodySchema,
  ResizeStorageResponseSchema,
  SandboxListQuerySchema,
  SandboxListResponseSchema,
  SandboxSchema,
} from "../../schemas/index.ts";
import { NotFoundError, ResourceExhaustedError } from "../../shared/errors.ts";
import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import { devRoutes } from "./dev.routes.ts";
import { sandboxIdGuard } from "./guard.ts";
import { servicesRoutes } from "./services.routes.ts";
import { terminalRoutes } from "./terminal.routes.ts";

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

      if (activeCount >= config.server.maxSandboxes) {
        throw new ResourceExhaustedError("sandboxes");
      }

      log.info({ body }, "Creating sandbox");

      const sandbox = await sandboxSpawner.spawn(body);
      set.status = 201;
      return sandbox;
    },
    {
      body: CreateSandboxBodySchema,
      response: CreateSandboxResponseSchema,
    },
  )
  .group("", (app) =>
    app
      .use(sandboxIdGuard)
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
      .post(
        "/:id/browser/start",
        async ({ sandbox }) => {
          if (sandbox.status !== "running") {
            return { status: "off" as const };
          }

          const kasmvnc = await agentClient.serviceStatus(
            sandbox.id,
            "kasmvnc",
          );
          if (kasmvnc.running) {
            const browserUrl = sandbox.runtime.urls.browser;
            return { status: "running" as const, url: browserUrl };
          }

          const browserPort = config.advanced.vm.browser.port;

          const ensureStarted = async (service: string) => {
            try {
              await agentClient.serviceStart(sandbox.id, service);
            } catch (err) {
              // 409 = already running, safe to ignore
              if (!String(err).includes("already running")) throw err;
            }
          };

          const startBrowser = async () => {
            await ensureStarted("kasmvnc");
            await new Promise((r) => setTimeout(r, 500));
            await ensureStarted("openbox");
            await new Promise((r) => setTimeout(r, 200));
            await ensureStarted("chromium");
          };

          startBrowser().catch((err) => {
            log.warn(
              { sandboxId: sandbox.id, error: String(err) },
              "Browser start failed",
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

          internalBus.emit("sandbox.poll-services", sandbox.id);
          return { status: "starting" as const, url: browserUrl };
        },
        {
          params: IdParamSchema,
          response: BrowserStartResponseSchema,
        },
      )
      .post(
        "/:id/browser/stop",
        async ({ sandbox }) => {
          if (sandbox.status !== "running") {
            return { status: "off" as const };
          }

          Promise.all([
            agentClient.serviceStop(sandbox.id, "chromium").catch(() => {}),
            agentClient.serviceStop(sandbox.id, "openbox").catch(() => {}),
            agentClient.serviceStop(sandbox.id, "kasmvnc").catch(() => {}),
          ]).catch(() => {});

          await CaddyService.removeBrowserRoute(sandbox.id);

          sandboxService.update(sandbox.id, {
            runtime: {
              ...sandbox.runtime,
              urls: { ...sandbox.runtime.urls, browser: undefined },
            },
          });

          internalBus.emit("sandbox.poll-services", sandbox.id);
          return { status: "off" as const };
        },
        {
          params: IdParamSchema,
          response: BrowserStopResponseSchema,
        },
      )
      .use(terminalRoutes)
      .use(servicesRoutes)
      .use(devRoutes),
  );
