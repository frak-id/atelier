import { Elysia } from "elysia";
import {
  agentClient,
  configFileService,
  sandboxService,
} from "../../container.ts";
import { QueueService } from "../../infrastructure/queue/index.ts";
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
  RegisterAppBodySchema,
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

      const sandbox = await sandboxService.spawn(body);
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
      const sandbox = await sandboxService.getStatus(params.id);
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
      await sandboxService.destroy(params.id);

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
      return sandboxService.stop(params.id);
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
      return sandboxService.start(params.id);
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
      return agentClient.health(params.id);
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
      return agentClient.metrics(params.id);
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
      return agentClient.getApps(params.id);
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
      return agentClient.registerApp(params.id, body.port, body.name);
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
      return agentClient.exec(params.id, body.command, {
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
      const result = await agentClient.logs(params.id, params.service, lines);
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
      return agentClient.services(params.id);
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
      return agentClient.gitStatus(params.id);
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
      const configs = await agentClient.discoverConfigs(params.id);
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
        params.id,
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
  );
