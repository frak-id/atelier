import { Elysia } from "elysia";
import { AgentClient } from "../../infrastructure/agent/index.ts";
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
import { ConfigFileService } from "../config-file/index.ts";
import { SandboxService } from "./sandbox.service.ts";

const log = createChildLogger("sandbox-routes");

export const sandboxRoutes = new Elysia({ prefix: "/sandboxes" })
  .get(
    "/",
    ({ query }) => {
      let sandboxes = SandboxService.getAll();

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
        SandboxService.countByStatus("running") +
        SandboxService.countByStatus("creating");

      if (activeCount >= config.defaults.MAX_SANDBOXES) {
        throw new ResourceExhaustedError("sandboxes");
      }

      log.info({ body }, "Creating sandbox");

      const sandbox = await SandboxService.spawn(body);
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
      const sandbox = await SandboxService.getStatus(params.id);
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
      const sandbox = SandboxService.getById(params.id);
      if (!sandbox) {
        throw new NotFoundError("Sandbox", params.id);
      }

      log.info({ sandboxId: params.id }, "Deleting sandbox");
      await SandboxService.destroy(params.id);

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
      const sandbox = SandboxService.getById(params.id);
      if (!sandbox) {
        throw new NotFoundError("Sandbox", params.id);
      }

      log.info({ sandboxId: params.id }, "Stopping sandbox");
      return SandboxService.stop(params.id);
    },
    {
      params: IdParamSchema,
      response: SandboxSchema,
    },
  )
  .post(
    "/:id/start",
    async ({ params }) => {
      const sandbox = SandboxService.getById(params.id);
      if (!sandbox) {
        throw new NotFoundError("Sandbox", params.id);
      }

      log.info({ sandboxId: params.id }, "Starting sandbox");
      return SandboxService.start(params.id);
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
      const sandbox = SandboxService.getById(params.id);
      if (!sandbox) {
        throw new NotFoundError("Sandbox", params.id);
      }
      return AgentClient.health(params.id);
    },
    {
      params: IdParamSchema,
      response: AgentHealthSchema,
    },
  )
  .get(
    "/:id/metrics",
    async ({ params }) => {
      const sandbox = SandboxService.getById(params.id);
      if (!sandbox) {
        throw new NotFoundError("Sandbox", params.id);
      }
      return AgentClient.metrics(params.id);
    },
    {
      params: IdParamSchema,
      response: AgentMetricsSchema,
    },
  )
  .get(
    "/:id/apps",
    async ({ params }) => {
      const sandbox = SandboxService.getById(params.id);
      if (!sandbox) {
        throw new NotFoundError("Sandbox", params.id);
      }
      return AgentClient.getApps(params.id);
    },
    {
      params: IdParamSchema,
      response: AppPortListResponseSchema,
    },
  )
  .post(
    "/:id/apps",
    async ({ params, body }) => {
      const sandbox = SandboxService.getById(params.id);
      if (!sandbox) {
        throw new NotFoundError("Sandbox", params.id);
      }
      return AgentClient.registerApp(params.id, body.port, body.name);
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
      const sandbox = SandboxService.getById(params.id);
      if (!sandbox) {
        throw new NotFoundError("Sandbox", params.id);
      }
      return AgentClient.exec(params.id, body.command, {
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
      const sandbox = SandboxService.getById(params.id);
      if (!sandbox) {
        throw new NotFoundError("Sandbox", params.id);
      }
      const lines = query.lines ? Number.parseInt(query.lines, 10) : 100;
      const result = await AgentClient.logs(params.id, params.service, lines);
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
      const sandbox = SandboxService.getById(params.id);
      if (!sandbox) {
        throw new NotFoundError("Sandbox", params.id);
      }
      return AgentClient.services(params.id);
    },
    {
      params: IdParamSchema,
      response: ServicesResponseSchema,
    },
  )
  .get(
    "/:id/git/status",
    async ({ params }) => {
      const sandbox = SandboxService.getById(params.id);
      if (!sandbox) {
        throw new NotFoundError("Sandbox", params.id);
      }
      return AgentClient.gitStatus(params.id);
    },
    {
      params: IdParamSchema,
      response: GitStatusResponseSchema,
    },
  )
  .get(
    "/:id/config/discover",
    async ({ params }) => {
      const sandbox = SandboxService.getById(params.id);
      if (!sandbox) {
        throw new NotFoundError("Sandbox", params.id);
      }
      const configs = await AgentClient.discoverConfigs(params.id);
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
      const sandbox = SandboxService.getById(params.id);
      if (!sandbox) {
        throw new NotFoundError("Sandbox", params.id);
      }

      const fileContent = await AgentClient.readConfigFile(
        params.id,
        body.path,
      );
      if (!fileContent) {
        throw new NotFoundError("ConfigFile", body.path);
      }

      const result = ConfigFileService.extractFromSandbox(
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
