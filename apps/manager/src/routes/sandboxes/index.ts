import { Elysia, t } from "elysia";
import { config } from "../../lib/config.ts";
import { NotFoundError, ResourceExhaustedError } from "../../lib/errors.ts";
import { createChildLogger } from "../../lib/logger.ts";
import { AgentClient } from "../../services/agent.ts";
import { FirecrackerService } from "../../services/firecracker.ts";
import { QueueService } from "../../services/queue.ts";
import { sandboxStore } from "../../state/store.ts";
import { SandboxModel } from "./model.ts";

const log = createChildLogger("sandboxes-route");

export const sandboxRoutes = new Elysia({ prefix: "/sandboxes" })
  .get(
    "/",
    ({ query }) => {
      let sandboxes = sandboxStore.getAll();

      if (query.status) {
        sandboxes = sandboxes.filter((s) => s.status === query.status);
      }

      if (query.projectId) {
        sandboxes = sandboxes.filter((s) => s.projectId === query.projectId);
      }

      return sandboxes;
    },
    {
      query: SandboxModel.listQuery,
      response: t.Array(SandboxModel.response),
    },
  )
  .post(
    "/",
    async ({ body, set }) => {
      const { async: useQueue, ...options } = body;
      const activeCount =
        sandboxStore.countByStatus("running") +
        sandboxStore.countByStatus("creating");

      if (activeCount >= config.defaults.MAX_SANDBOXES) {
        throw new ResourceExhaustedError("sandboxes");
      }

      log.info({ body, useQueue }, "Creating sandbox");

      if (useQueue) {
        const job = await QueueService.enqueue(options);
        set.status = 202;
        return {
          id: job.id,
          status: job.status,
          queuedAt: job.queuedAt,
          startedAt: job.startedAt,
          completedAt: job.completedAt,
          error: job.error,
        };
      }

      const sandbox = await FirecrackerService.spawn(options);
      set.status = 201;
      return sandbox;
    },
    {
      body: SandboxModel.createQueued,
      response: t.Union([SandboxModel.response, SandboxModel.jobResponse]),
    },
  )
  .get(
    "/job/:id",
    ({ params }) => {
      const job = QueueService.getJob(params.id);
      if (!job) {
        throw new NotFoundError("Job", params.id);
      }

      return {
        id: job.id,
        status: job.status,
        queuedAt: job.queuedAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        error: job.error,
        result: job.result,
      };
    },
    {
      params: SandboxModel.idParam,
      response: t.Object({
        id: t.String(),
        status: t.Union([
          t.Literal("queued"),
          t.Literal("running"),
          t.Literal("completed"),
          t.Literal("failed"),
        ]),
        queuedAt: t.String(),
        startedAt: t.Optional(t.String()),
        completedAt: t.Optional(t.String()),
        error: t.Optional(t.String()),
        result: t.Optional(SandboxModel.response),
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
      params: SandboxModel.idParam,
      response: SandboxModel.response,
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
      params: SandboxModel.idParam,
    },
  )
  // Agent routes - communicate with sandbox-agent inside VM
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
      params: SandboxModel.idParam,
      detail: { tags: ["sandboxes"], summary: "Get sandbox agent health" },
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
      params: SandboxModel.idParam,
      detail: { tags: ["sandboxes"], summary: "Get sandbox resource metrics" },
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
      params: SandboxModel.idParam,
      detail: {
        tags: ["sandboxes"],
        summary: "List registered apps in sandbox",
      },
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
      params: SandboxModel.idParam,
      body: t.Object({
        port: t.Number({ minimum: 1, maximum: 65535 }),
        name: t.String(),
      }),
      detail: {
        tags: ["sandboxes"],
        summary: "Register an app port in sandbox",
      },
    },
  )
  .delete(
    "/:id/apps/:port",
    async ({ params }) => {
      const sandbox = sandboxStore.getById(params.id);
      if (!sandbox) {
        throw new NotFoundError("Sandbox", params.id);
      }

      return AgentClient.unregisterApp(params.id, parseInt(params.port, 10));
    },
    {
      params: t.Object({
        id: t.String(),
        port: t.String(),
      }),
      detail: {
        tags: ["sandboxes"],
        summary: "Unregister an app port from sandbox",
      },
    },
  )
  .post(
    "/:id/exec",
    async ({ params, body }) => {
      const sandbox = sandboxStore.getById(params.id);
      if (!sandbox) {
        throw new NotFoundError("Sandbox", params.id);
      }

      log.info(
        { sandboxId: params.id, command: body.command },
        "Executing command in sandbox",
      );
      return AgentClient.exec(params.id, body.command, {
        timeout: body.timeout,
      });
    },
    {
      params: SandboxModel.idParam,
      body: t.Object({
        command: t.String(),
        timeout: t.Optional(t.Number({ minimum: 1000, maximum: 300000 })),
      }),
      detail: { tags: ["sandboxes"], summary: "Execute a command in sandbox" },
    },
  )
  .get(
    "/:id/logs/:service",
    async ({ params, query }) => {
      const sandbox = sandboxStore.getById(params.id);
      if (!sandbox) {
        throw new NotFoundError("Sandbox", params.id);
      }

      const lines = query.lines ? parseInt(query.lines, 10) : 100;
      return AgentClient.logs(params.id, params.service, lines);
    },
    {
      params: t.Object({
        id: t.String(),
        service: t.String(),
      }),
      query: t.Object({
        lines: t.Optional(t.String()),
      }),
      detail: { tags: ["sandboxes"], summary: "Get service logs from sandbox" },
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
      params: SandboxModel.idParam,
      detail: {
        tags: ["sandboxes"],
        summary: "Get service status from sandbox",
      },
    },
  );
