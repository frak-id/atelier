import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { Elysia, sse } from "elysia";
import {
  agentClient,
  agentOperations,
  orgMemberService,
  sandboxDestroyer,
  sandboxLifecycle,
  sandboxService,
  sandboxSpawner,
  workspaceService,
} from "../../container.ts";
import { internalBus } from "../../infrastructure/events/internal-bus.ts";
import {
  buildBrowserIngress,
  kubeClient,
} from "../../infrastructure/kubernetes/index.ts";
import { SYSTEM_WORKSPACE_ID } from "../../modules/system-sandbox/index.ts";
import { waitForOpencodeHealthy } from "../../orchestrators/kernel/boot-waiter.ts";
import type { ServiceStatus } from "../../schemas/index.ts";
import {
  AgentHealthSchema,
  AllServicesResponseSchema,
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
  SandboxListQuerySchema,
  SandboxListResponseSchema,
  SandboxSchema,
  StartSandboxSessionBodySchema,
} from "../../schemas/index.ts";
import { NotFoundError, ResourceExhaustedError } from "../../shared/errors.ts";
import { authPlugin } from "../../shared/lib/auth.ts";
import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import { buildOpenCodeAuthHeaders } from "../../shared/lib/opencode-auth.ts";
import { startOpencodeSession } from "../../shared/lib/opencode-session.ts";
import { devRoutes } from "./dev.routes.ts";
import { sandboxIdGuard } from "./guard.ts";
import { servicesRoutes } from "./services.routes.ts";
import { terminalRoutes } from "./terminal.routes.ts";

const log = createChildLogger("sandbox-routes");

export const sandboxRoutes = new Elysia({ prefix: "/sandboxes" })
  .use(authPlugin)
  .get(
    "/",
    ({ query, user }) => {
      const memberships = orgMemberService.getByUserId(user.id);
      const orgIds = memberships.map((m) => m.orgId);

      let sandboxes = sandboxService
        .getByOrgIds(orgIds)
        .filter((s) => s.workspaceId !== SYSTEM_WORKSPACE_ID);

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
    async ({ body, set, user }) => {
      const allActive = [
        ...sandboxService.getByStatus("running"),
        ...sandboxService.getByStatus("creating"),
      ].filter((s) => s.workspaceId !== SYSTEM_WORKSPACE_ID);

      if (allActive.length >= config.server.maxSandboxes) {
        throw new ResourceExhaustedError("sandboxes");
      }

      log.info({ body }, "Creating sandbox");

      const sandbox = await sandboxSpawner.spawn(body, undefined, user.id);
      set.status = 201;
      return sandbox;
    },
    {
      body: CreateSandboxBodySchema,
      response: CreateSandboxResponseSchema,
    },
  )
  .post(
    "/start-session",
    async function* ({ body, user }) {
      const allActive = [
        ...sandboxService.getByStatus("running"),
        ...sandboxService.getByStatus("creating"),
      ].filter((s) => s.workspaceId !== SYSTEM_WORKSPACE_ID);

      if (allActive.length >= config.server.maxSandboxes) {
        throw new ResourceExhaustedError("sandboxes");
      }

      log.info({ workspaceId: body.workspaceId }, "Starting sandbox + session");

      try {
        yield sse({ data: { type: "progress", stage: "spawning-sandbox" } });
        const sandbox = await sandboxSpawner.spawn(
          { workspaceId: body.workspaceId },
          undefined,
          user.id,
        );

        yield sse({
          data: {
            type: "progress",
            stage: "waiting-for-agent",
            sandboxId: sandbox.id,
          },
        });
        const { ready: agentReady } = await agentClient.waitForAgent(
          sandbox.id,
          { timeout: 60000 },
        );
        if (!agentReady) {
          throw new Error("Agent failed to become ready");
        }

        yield sse({
          data: {
            type: "progress",
            stage: "waiting-for-opencode",
            sandboxId: sandbox.id,
          },
        });
        // Healthy is enough here — `startOpencodeSession` below goes through
        // `openOpencodeSession`, which waits for the agent registry before
        // creating the session and issuing the prompt.
        await waitForOpencodeHealthy(
          sandbox.runtime.ipAddress,
          sandbox.runtime.opencodePassword,
        );

        yield sse({
          data: {
            type: "progress",
            stage: "creating-session",
            sandboxId: sandbox.id,
          },
        });
        const client = createOpencodeClient({
          baseUrl: `http://${sandbox.runtime.ipAddress}:${config.ports.opencode}`,
          headers: buildOpenCodeAuthHeaders(sandbox.runtime.opencodePassword),
        });
        const session = await startOpencodeSession(client, {
          prompt: body.message,
          model: body.templateConfig?.model,
          variant: body.templateConfig?.variant,
          agent: body.templateConfig?.agent,
        });

        const opencodeUrl = sandbox.runtime.urls.opencode;
        const encodedDirectory = Buffer.from(session.directory).toString(
          "base64url",
        );
        const sessionUrl = `${opencodeUrl}/${encodedDirectory}/session/${session.id}`;

        yield sse({
          data: {
            type: "done",
            sandboxId: sandbox.id,
            sessionId: session.id,
            sessionUrl,
            directory: session.directory,
            opencodeUrl,
          },
        });
      } catch (err) {
        log.error({ error: err }, "start-session stream failed");
        yield sse({
          data: {
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
    },
    {
      body: StartSandboxSessionBodySchema,
    },
  )
  .get(
    "/all-services",
    async () => {
      const running = sandboxService
        .getByStatus("running")
        .filter((s) => s.workspaceId !== SYSTEM_WORKSPACE_ID);

      const results = await Promise.allSettled(
        running.map(async (s) => ({
          id: s.id,
          services: await agentOperations.services(s.id),
        })),
      );

      const response: Record<string, ServiceStatus[]> = {};
      for (const result of results) {
        if (result.status === "fulfilled") {
          response[result.value.id] = result.value.services.services;
        }
      }

      return response;
    },
    {
      response: AllServicesResponseSchema,
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
      .post(
        "/:id/recover",
        async ({ params, sandbox: _sandbox }) => {
          log.info({ sandboxId: params.id }, "Recovering sandbox");
          return sandboxLifecycle.recover(params.id);
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

          const startBrowser = async () => {
            await agentClient.serviceStart(sandbox.id, "kasmvnc");
            await new Promise((r) => setTimeout(r, 500));
            await agentClient.serviceStart(sandbox.id, "openbox");
            await new Promise((r) => setTimeout(r, 200));
            await agentClient.serviceStart(sandbox.id, "chromium");
          };

          startBrowser().catch((err) => {
            log.warn(
              { sandboxId: sandbox.id, error: String(err) },
              "Browser start failed",
            );
          });

          const browserUrl = `https://browser-${sandbox.id}.${config.domain.dashboard}`;

          try {
            await kubeClient.createResource(
              buildBrowserIngress(sandbox.id, config.domain.dashboard, {
                ingressClassName:
                  config.kubernetes.ingressClassName || undefined,
                annotations: config.kubernetes.vsCodeIngressAnnotations,
                tlsSecretName: "atelier-sandbox-wildcard-tls",
              }),
            );
          } catch (err) {
            log.warn(
              { sandboxId: sandbox.id, error: err },
              "Failed to create browser ingress",
            );
          }

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

          kubeClient
            .deleteResource("ingresses", `sandbox-browser-${sandbox.id}`)
            .catch(() => {});

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
