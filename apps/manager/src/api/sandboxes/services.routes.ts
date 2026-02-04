import Elysia from "elysia";
import { sandboxIdGuard } from "./guard";
import { agentClient, agentOperations } from "../../container";
import {
  IdParamSchema,
  ServiceActionResponseSchema,
  ServiceNameParamsSchema,
  ServicesResponseSchema,
} from "../../schemas";
import { internalBus } from "../../infrastructure/events";

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
    "/:id/services/:name/restart",
    async ({ params, sandbox }) => {
      const result = await agentClient.serviceRestart(sandbox.id, params.name);
      internalBus.emit("sandbox.poll-services", sandbox.id);
      return result;
    },
    {
      params: ServiceNameParamsSchema,
      response: ServiceActionResponseSchema,
    },
  );
