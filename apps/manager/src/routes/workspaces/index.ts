import { Elysia } from "elysia";
import { nanoid } from "nanoid";
import { NotFoundError } from "../../lib/errors.ts";
import { createChildLogger } from "../../lib/logger.ts";
import {
  CreateWorkspaceBodySchema,
  DEFAULT_WORKSPACE_CONFIG,
  IdParamSchema,
  PrebuildTriggerResponseSchema,
  UpdateWorkspaceBodySchema,
  type Workspace,
  type WorkspaceConfig,
  WorkspaceListResponseSchema,
  WorkspaceSchema,
} from "../../schemas/index.ts";
import { PrebuildService } from "../../services/prebuild.ts";
import { StorageService } from "../../services/storage.ts";
import { WorkspaceRepository } from "../../state/database.ts";

const log = createChildLogger("workspaces-route");

export const workspaceRoutes = new Elysia({ prefix: "/workspaces" })
  .get(
    "/",
    () => {
      return WorkspaceRepository.getAll();
    },
    {
      response: WorkspaceListResponseSchema,
    },
  )
  .post(
    "/",
    async ({ body, set }) => {
      const now = new Date().toISOString();
      const config: WorkspaceConfig = {
        ...DEFAULT_WORKSPACE_CONFIG,
        ...body.config,
      };

      const workspace: Workspace = {
        id: nanoid(12),
        name: body.name,
        config,
        createdAt: now,
        updatedAt: now,
      };

      log.info(
        { workspaceId: workspace.id, name: workspace.name },
        "Creating workspace",
      );
      WorkspaceRepository.create(workspace);

      if (config.repos && config.repos.length > 0) {
        log.info({ workspaceId: workspace.id }, "Triggering initial prebuild");
        PrebuildService.createInBackground(workspace.id);
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
      const workspace = WorkspaceRepository.getById(params.id);
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
      const existing = WorkspaceRepository.getById(params.id);
      if (!existing) {
        throw new NotFoundError("Workspace", params.id);
      }

      log.info({ workspaceId: params.id }, "Updating workspace");

      const updates: Partial<Workspace> = {};
      if (body.name !== undefined) updates.name = body.name;
      if (body.config !== undefined) {
        updates.config = {
          ...existing.config,
          ...body.config,
        } as WorkspaceConfig;
      }

      return WorkspaceRepository.update(params.id, updates);
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
      const existing = WorkspaceRepository.getById(params.id);
      if (!existing) {
        throw new NotFoundError("Workspace", params.id);
      }

      log.info({ workspaceId: params.id }, "Deleting workspace");
      await StorageService.deletePrebuild(params.id);
      WorkspaceRepository.delete(params.id);
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
      const workspace = WorkspaceRepository.getById(params.id);
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
      const workspace = WorkspaceRepository.getById(params.id);
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
