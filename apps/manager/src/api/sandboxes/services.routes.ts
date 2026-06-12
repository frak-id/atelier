import Elysia from "elysia";
import { agentClient, agentOperations } from "../../container";
import { internalBus } from "../../infrastructure/events";
import {
  IdParamSchema,
  ServiceActionResponseSchema,
  ServiceLogsQuerySchema,
  ServiceLogsResponseSchema,
  ServiceNameParamsSchema,
  ServicesResponseSchema,
} from "../../schemas";
import { sandboxIdGuard } from "./guard";

export const servicesRoutes = new Elysia()
  .use(sandboxIdGuard)
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
  .post(
    "/:id/services/:name/stop",
    async ({ params, sandbox }) => {
      const result = await agentClient.serviceStop(sandbox.id, params.name);
      internalBus.emit("sandbox.poll-services", sandbox.id);
      return result;
    },
    {
      params: ServiceNameParamsSchema,
      response: ServiceActionResponseSchema,
    },
  )
  .post(
    "/:id/services/:name/start",
    async ({ params, sandbox }) => {
      const result = await agentClient.serviceStart(sandbox.id, params.name);
      internalBus.emit("sandbox.poll-services", sandbox.id);
      return result;
    },
    {
      params: ServiceNameParamsSchema,
      response: ServiceActionResponseSchema,
    },
  )
  .get(
    "/:id/services/:name/logs",
    async ({ params, query, sandbox }) => {
      const offset = query.offset ? Number.parseInt(query.offset, 10) : 0;
      const limit = query.limit ? Number.parseInt(query.limit, 10) : 10000;
      return agentClient.serviceLogs(sandbox.id, params.name, offset, limit);
    },
    {
      params: ServiceNameParamsSchema,
      query: ServiceLogsQuerySchema,
      response: ServiceLogsResponseSchema,
    },
  );
