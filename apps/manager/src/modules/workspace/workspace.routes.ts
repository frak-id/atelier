import { Elysia } from "elysia";
import {
  CreateWorkspaceBodySchema,
  IdParamSchema,
  PrebuildTriggerResponseSchema,
  UpdateWorkspaceBodySchema,
  WorkspaceListResponseSchema,
  WorkspaceSchema,
} from "../../schemas/index.ts";
import { NotFoundError } from "../../shared/errors.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import { PrebuildService } from "../prebuild/index.ts";
import { WorkspaceService } from "./workspace.service.ts";

const log = createChildLogger("workspace-routes");

export const workspaceRoutes = new Elysia({ prefix: "/workspaces" })
  .get(
    "/",
    () => {
      return WorkspaceService.getAll();
    },
    {
      response: WorkspaceListResponseSchema,
    },
  )
  .post(
    "/",
    async ({ body, set }) => {
      log.info({ name: body.name }, "Creating workspace");
      const workspace = WorkspaceService.create(body.name, body.config);
      set.status = 201;
      return workspace;
    },
    {
      body: CreateWorkspaceBodySchema,
      response: WorkspaceSchema,
    },
  )
  .get(
    "/:id",
    ({ params }) => {
      const workspace = WorkspaceService.getById(params.id);
      if (!workspace) {
        throw new NotFoundError("Workspace", params.id);
      }
      return workspace;
    },
    {
      params: IdParamSchema,
      response: WorkspaceSchema,
    },
  )
  .put(
    "/:id",
    ({ params, body }) => {
      log.info({ workspaceId: params.id }, "Updating workspace");
      return WorkspaceService.update(params.id, {
        name: body.name,
        config: body.config,
      });
    },
    {
      params: IdParamSchema,
      body: UpdateWorkspaceBodySchema,
      response: WorkspaceSchema,
    },
  )
  .delete(
    "/:id",
    async ({ params, set }) => {
      log.info({ workspaceId: params.id }, "Deleting workspace");
      await WorkspaceService.delete(params.id);
      set.status = 204;
      return null;
    },
    {
      params: IdParamSchema,
    },
  )
  .post(
    "/:id/prebuild",
    async ({ params, set }) => {
      const workspace = WorkspaceService.getById(params.id);
      if (!workspace) {
        throw new NotFoundError("Workspace", params.id);
      }

      if (workspace.config.prebuild?.status === "building") {
        return {
          message: "Prebuild already in progress",
          workspaceId: params.id,
          status: "building",
        };
      }

      log.info({ workspaceId: params.id }, "Triggering prebuild");
      PrebuildService.createInBackground(params.id);

      set.status = 202;
      return {
        message: "Prebuild triggered",
        workspaceId: params.id,
        status: "building",
      };
    },
    {
      params: IdParamSchema,
      response: PrebuildTriggerResponseSchema,
    },
  )
  .delete(
    "/:id/prebuild",
    async ({ params, set }) => {
      const workspace = WorkspaceService.getById(params.id);
      if (!workspace) {
        throw new NotFoundError("Workspace", params.id);
      }

      log.info({ workspaceId: params.id }, "Deleting prebuild");
      await PrebuildService.delete(params.id);

      set.status = 204;
      return null;
    },
    {
      params: IdParamSchema,
    },
  );
