import { Elysia, t } from "elysia";
import { config } from "../../lib/config.ts";
import { NotFoundError, ResourceExhaustedError } from "../../lib/errors.ts";
import { createChildLogger } from "../../lib/logger.ts";
import { AgentClient } from "../../services/agent.ts";
import { ConfigFilesService } from "../../services/config-files.ts";
import { FirecrackerService } from "../../services/firecracker.ts";
import { QueueService } from "../../services/queue.ts";
import { sandboxStore } from "../../state/store.ts";

const log = createChildLogger("sandboxes-route");

const SandboxStatusEnum = t.Union([
  t.Literal("creating"),
  t.Literal("running"),
  t.Literal("stopped"),
  t.Literal("error"),
]);

export const sandboxRoutes = new Elysia({ prefix: "/sandboxes" })
  .get(
    "/",
    ({ query }) => {
      let sandboxes = sandboxStore.getAll();

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
      query: t.Object({
        status: t.Optional(SandboxStatusEnum),
        workspaceId: t.Optional(t.String()),
      }),
    },
  )
  .post(
    "/",
    async ({ body, set }) => {
      const activeCount =
        sandboxStore.countByStatus("running") +
        sandboxStore.countByStatus("creating");

      if (activeCount >= config.defaults.MAX_SANDBOXES) {
        throw new ResourceExhaustedError("sandboxes");
      }

      log.info({ body }, "Creating sandbox");

      const sandbox = await FirecrackerService.spawn(body);
      set.status = 201;
      return sandbox;
    },
    {
      body: t.Object({
        workspaceId: t.Optional(t.String()),
        baseImage: t.Optional(t.String()),
        vcpus: t.Optional(t.Number({ minimum: 1, maximum: 8 })),
        memoryMb: t.Optional(t.Number({ minimum: 512, maximum: 16384 })),
      }),
    },
  )
  .get(
    "/:id",
    async ({ params }) => {
      const sandbox = await FirecrackerService.getStatus(params.id);
      if (!sandbox) {
        throw new NotFoundError("Sandbox", params.id);
      }
      return sandbox;
    },
    {
      params: t.Object({ id: t.String() }),
    },
  )
  .delete(
    "/:id",
    async ({ params, set }) => {
      const sandbox = sandboxStore.getById(params.id);
      if (!sandbox) {
        throw new NotFoundError("Sandbox", params.id);
      }

      log.info({ sandboxId: params.id }, "Deleting sandbox");
      await FirecrackerService.destroy(params.id);

      set.status = 204;
      return null;
    },
    {
      params: t.Object({ id: t.String() }),
    },
  )
  .post(
    "/:id/stop",
    async ({ params }) => {
      const sandbox = sandboxStore.getById(params.id);
      if (!sandbox) {
        throw new NotFoundError("Sandbox", params.id);
      }

      log.info({ sandboxId: params.id }, "Stopping sandbox");
      return FirecrackerService.stop(params.id);
    },
    {
      params: t.Object({ id: t.String() }),
    },
  )
  .post(
    "/:id/start",
    async ({ params }) => {
      const sandbox = sandboxStore.getById(params.id);
      if (!sandbox) {
        throw new NotFoundError("Sandbox", params.id);
      }

      log.info({ sandboxId: params.id }, "Starting sandbox");
      return FirecrackerService.start(params.id);
    },
    {
      params: t.Object({ id: t.String() }),
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
      params: t.Object({ id: t.String() }),
    },
  )
  .get(
    "/:id/health",
    async ({ params }) => {
      const sandbox = sandboxStore.getById(params.id);
      if (!sandbox) {
        throw new NotFoundError("Sandbox", params.id);
      }
      return AgentClient.health(params.id);
    },
    {
      params: t.Object({ id: t.String() }),
    },
  )
  .get(
    "/:id/metrics",
    async ({ params }) => {
      const sandbox = sandboxStore.getById(params.id);
      if (!sandbox) {
        throw new NotFoundError("Sandbox", params.id);
      }
      return AgentClient.metrics(params.id);
    },
    {
      params: t.Object({ id: t.String() }),
    },
  )
  .get(
    "/:id/apps",
    async ({ params }) => {
      const sandbox = sandboxStore.getById(params.id);
      if (!sandbox) {
        throw new NotFoundError("Sandbox", params.id);
      }
      return AgentClient.getApps(params.id);
    },
    {
      params: t.Object({ id: t.String() }),
    },
  )
  .post(
    "/:id/apps",
    async ({ params, body }) => {
      const sandbox = sandboxStore.getById(params.id);
      if (!sandbox) {
        throw new NotFoundError("Sandbox", params.id);
      }
      return AgentClient.registerApp(params.id, body.port, body.name);
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        port: t.Number({ minimum: 1, maximum: 65535 }),
        name: t.String({ minLength: 1, maxLength: 100 }),
      }),
    },
  )
  .post(
    "/:id/exec",
    async ({ params, body }) => {
      const sandbox = sandboxStore.getById(params.id);
      if (!sandbox) {
        throw new NotFoundError("Sandbox", params.id);
      }
      return AgentClient.exec(params.id, body.command, {
        timeout: body.timeout,
      });
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        command: t.String({ minLength: 1 }),
        timeout: t.Optional(t.Number({ minimum: 1000, maximum: 300000 })),
      }),
    },
  )
  .get(
    "/:id/logs/:service",
    async ({ params, query }) => {
      const sandbox = sandboxStore.getById(params.id);
      if (!sandbox) {
        throw new NotFoundError("Sandbox", params.id);
      }
      const lines = query.lines ? Number.parseInt(query.lines, 10) : 100;
      const result = await AgentClient.logs(params.id, params.service, lines);
      return { logs: result.content };
    },
    {
      params: t.Object({ id: t.String(), service: t.String() }),
      query: t.Object({ lines: t.Optional(t.String()) }),
    },
  )
  .get(
    "/:id/services",
    async ({ params }) => {
      const sandbox = sandboxStore.getById(params.id);
      if (!sandbox) {
        throw new NotFoundError("Sandbox", params.id);
      }
      return AgentClient.services(params.id);
    },
    {
      params: t.Object({ id: t.String() }),
    },
  )
  .get(
    "/:id/config/discover",
    async ({ params }) => {
      const sandbox = sandboxStore.getById(params.id);
      if (!sandbox) {
        throw new NotFoundError("Sandbox", params.id);
      }
      const configs = await AgentClient.discoverConfigs(params.id);
      return { configs };
    },
    {
      params: t.Object({ id: t.String() }),
    },
  )
  .post(
    "/:id/config/extract",
    async ({ params, body }) => {
      const sandbox = sandboxStore.getById(params.id);
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

      const result = await ConfigFilesService.extractFromSandbox(
        sandbox.workspaceId,
        fileContent.path,
        fileContent.content,
        fileContent.contentType,
      );

      return result;
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({ path: t.String({ minLength: 1 }) }),
    },
  );
