import { Elysia } from "elysia";
import {
  agentClient,
  configFileService,
  sandboxDestroyer,
  sandboxLifecycle,
  sandboxService,
  sandboxSpawner,
  workspaceService,
} from "../../container.ts";
import { QueueService } from "../../infrastructure/queue/index.ts";
import { StorageService } from "../../infrastructure/storage/index.ts";
import {
  AgentHealthSchema,
  AgentMetricsSchema,
  AppPortListResponseSchema,
  AppPortSchema,
  CreateSandboxBodySchema,
  DiscoverConfigsResponseSchema,
  ExecBodySchema,
  ExecResponseSchema,
  ExtractConfigBodySchema,
  ExtractConfigResponseSchema,
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
} from "../../schemas/index.ts";
import { NotFoundError, ResourceExhaustedError } from "../../shared/errors.ts";
import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";

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
  .get(
    "/:id",
    async ({ params }) => {
      const sandbox = sandboxService.getById(params.id);
      if (!sandbox) {
        throw new NotFoundError("Sandbox", params.id);
      }
      return sandbox;
    },
    {
      params: IdParamSchema,
      response: SandboxSchema,
    },
  )
  .delete(
    "/:id",
    async ({ params, set }) => {
      const sandbox = sandboxService.getById(params.id);
      if (!sandbox) {
        throw new NotFoundError("Sandbox", params.id);
      }

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
    async ({ params }) => {
      const sandbox = sandboxService.getById(params.id);
      if (!sandbox) {
        throw new NotFoundError("Sandbox", params.id);
      }

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
    async ({ params }) => {
      const sandbox = sandboxService.getById(params.id);
      if (!sandbox) {
        throw new NotFoundError("Sandbox", params.id);
      }

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
    async ({ params }) => {
      const sandbox = sandboxService.getById(params.id);
      if (!sandbox) {
        throw new NotFoundError("Sandbox", params.id);
      }

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
  )
  .get(
    "/:id/health",
    async ({ params }) => {
      const sandbox = sandboxService.getById(params.id);
      if (!sandbox) {
        throw new NotFoundError("Sandbox", params.id);
      }
      return agentClient.health(sandbox.runtime.ipAddress);
    },
    {
      params: IdParamSchema,
      response: AgentHealthSchema,
    },
  )
  .get(
    "/:id/metrics",
    async ({ params }) => {
      const sandbox = sandboxService.getById(params.id);
      if (!sandbox) {
        throw new NotFoundError("Sandbox", params.id);
      }
      return agentClient.metrics(sandbox.runtime.ipAddress);
    },
    {
      params: IdParamSchema,
      response: AgentMetricsSchema,
    },
  )
  .get(
    "/:id/apps",
    async ({ params }) => {
      const sandbox = sandboxService.getById(params.id);
      if (!sandbox) {
        throw new NotFoundError("Sandbox", params.id);
      }
      return agentClient.getApps(sandbox.runtime.ipAddress);
    },
    {
      params: IdParamSchema,
      response: AppPortListResponseSchema,
    },
  )
  .post(
    "/:id/apps",
    async ({ params, body }) => {
      const sandbox = sandboxService.getById(params.id);
      if (!sandbox) {
        throw new NotFoundError("Sandbox", params.id);
      }
      return agentClient.registerApp(
        sandbox.runtime.ipAddress,
        body.port,
        body.name,
      );
    },
    {
      params: IdParamSchema,
      body: RegisterAppBodySchema,
      response: AppPortSchema,
    },
  )
  .post(
    "/:id/exec",
    async ({ params, body }) => {
      const sandbox = sandboxService.getById(params.id);
      if (!sandbox) {
        throw new NotFoundError("Sandbox", params.id);
      }
      return agentClient.exec(sandbox.runtime.ipAddress, body.command, {
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
    async ({ params, query }) => {
      const sandbox = sandboxService.getById(params.id);
      if (!sandbox) {
        throw new NotFoundError("Sandbox", params.id);
      }
      const lines = query.lines ? Number.parseInt(query.lines, 10) : 100;
      const result = await agentClient.logs(
        sandbox.runtime.ipAddress,
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
    async ({ params }) => {
      const sandbox = sandboxService.getById(params.id);
      if (!sandbox) {
        throw new NotFoundError("Sandbox", params.id);
      }
      return agentClient.services(sandbox.runtime.ipAddress);
    },
    {
      params: IdParamSchema,
      response: ServicesResponseSchema,
    },
  )
  .get(
    "/:id/git/status",
    async ({ params }) => {
      const sandbox = sandboxService.getById(params.id);
      if (!sandbox) {
        throw new NotFoundError("Sandbox", params.id);
      }
      return agentClient.gitStatus(sandbox.runtime.ipAddress);
    },
    {
      params: IdParamSchema,
      response: GitStatusResponseSchema,
    },
  )
  .get(
    "/:id/config/discover",
    async ({ params }) => {
      const sandbox = sandboxService.getById(params.id);
      if (!sandbox) {
        throw new NotFoundError("Sandbox", params.id);
      }
      const configs = await agentClient.discoverConfigs(
        sandbox.runtime.ipAddress,
      );
      return { configs };
    },
    {
      params: IdParamSchema,
      response: DiscoverConfigsResponseSchema,
    },
  )
  .post(
    "/:id/config/extract",
    async ({ params, body }) => {
      const sandbox = sandboxService.getById(params.id);
      if (!sandbox) {
        throw new NotFoundError("Sandbox", params.id);
      }

      const fileContent = await agentClient.readConfigFile(
        sandbox.runtime.ipAddress,
        body.path,
      );
      if (!fileContent) {
        throw new NotFoundError("ConfigFile", body.path);
      }

      const result = configFileService.extractFromSandbox(
        sandbox.workspaceId,
        fileContent.path,
        fileContent.content,
        fileContent.contentType,
      );

      return result;
    },
    {
      params: IdParamSchema,
      body: ExtractConfigBodySchema,
      response: ExtractConfigResponseSchema,
    },
  )
  .post(
    "/:id/storage/resize",
    async ({ params, body }) => {
      const sandbox = sandboxService.getById(params.id);
      if (!sandbox) {
        throw new NotFoundError("Sandbox", params.id);
      }

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

      const agentResult = await agentClient.resizeStorage(
        sandbox.runtime.ipAddress,
      );

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
    async ({ params }) => {
      const sandbox = sandboxService.getById(params.id);
      if (!sandbox) {
        throw new NotFoundError("Sandbox", params.id);
      }

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

      await agentClient.exec(sandbox.runtime.ipAddress, "sync");
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
  );
