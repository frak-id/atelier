import { Elysia } from "elysia";
import { prebuildRunner, workspaceService } from "../container.ts";
import { StorageService } from "../infrastructure/storage/index.ts";
import {
  CreateWorkspaceBodySchema,
  IdParamSchema,
  PrebuildTriggerResponseSchema,
  UpdateWorkspaceBodySchema,
  WorkspaceListResponseSchema,
  WorkspaceSchema,
} from "../schemas/index.ts";
import { NotFoundError } from "../shared/errors.ts";
import { createChildLogger } from "../shared/lib/logger.ts";

const log = createChildLogger("workspace-routes");

export const workspaceRoutes = new Elysia({ prefix: "/workspaces" })
  .get(
    "/",
    () => {
      return workspaceService.getAll();
    },
    {
      response: WorkspaceListResponseSchema,
    },
  )
  .post(
    "/",
    async ({ body, set }) => {
      log.info({ name: body.name }, "Creating workspace");
      const workspace = workspaceService.create(body.name, body.config);

      const hasRepos = body.config?.repos && body.config.repos.length > 0;
      if (hasRepos) {
        log.info({ workspaceId: workspace.id }, "Triggering initial prebuild");
        prebuildRunner.runInBackground(workspace.id);
      }

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
      const workspace = workspaceService.getById(params.id);
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
      return workspaceService.update(params.id, {
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
      const workspace = workspaceService.getById(params.id);
      if (!workspace) {
        throw new NotFoundError("Workspace", params.id);
      }

      log.info({ workspaceId: params.id }, "Deleting workspace");
      await StorageService.deletePrebuild(params.id);
      workspaceService.delete(params.id);

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
      const workspace = workspaceService.getById(params.id);
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
      prebuildRunner.runInBackground(params.id);

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
      const workspace = workspaceService.getById(params.id);
      if (!workspace) {
        throw new NotFoundError("Workspace", params.id);
      }

      log.info({ workspaceId: params.id }, "Deleting prebuild");
      await prebuildRunner.delete(params.id);

      set.status = 204;
      return null;
    },
    {
      params: IdParamSchema,
    },
  );
