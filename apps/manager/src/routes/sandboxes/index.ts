import { Elysia, t } from "elysia";
import { SandboxModel } from "./model.ts";
import { FirecrackerService } from "../../services/firecracker.ts";
import { sandboxStore } from "../../state/store.ts";
import { NotFoundError, ResourceExhaustedError } from "../../lib/errors.ts";
import { config } from "../../lib/config.ts";
import { createChildLogger } from "../../lib/logger.ts";

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
    }
  )
  .post(
    "/",
    async ({ body, set }) => {
      const activeCount = sandboxStore.countByStatus("running") +
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
      body: SandboxModel.create,
      response: SandboxModel.response,
    }
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
    }
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
    }
  );
