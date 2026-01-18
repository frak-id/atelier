import { Elysia, t } from "elysia";
import { nanoid } from "nanoid";
import { NotFoundError } from "../../lib/errors.ts";
import { createChildLogger } from "../../lib/logger.ts";
import { PrebuildService } from "../../services/prebuild.ts";
import { StorageService } from "../../services/storage.ts";
import { WorkspaceRepository } from "../../state/database.ts";
import {
  DEFAULT_WORKSPACE_CONFIG,
  type Workspace,
  type WorkspaceConfig,
} from "../../types/index.ts";

const log = createChildLogger("workspaces-route");

export const workspaceRoutes = new Elysia({ prefix: "/workspaces" })
  .get("/", () => {
    return WorkspaceRepository.getAll();
  })
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
      body: t.Object({
        name: t.String({ minLength: 1, maxLength: 100 }),
        config: t.Optional(t.Record(t.String(), t.Unknown())),
      }),
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
      params: t.Object({ id: t.String() }),
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
      params: t.Object({ id: t.String() }),
      body: t.Object({
        name: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
        config: t.Optional(t.Record(t.String(), t.Unknown())),
      }),
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
      params: t.Object({ id: t.String() }),
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
      params: t.Object({ id: t.String() }),
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
      params: t.Object({ id: t.String() }),
    },
  );
