import { Elysia, t } from "elysia";
import { nanoid } from "nanoid";
import { NotFoundError } from "../../lib/errors.ts";
import { createChildLogger } from "../../lib/logger.ts";
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
    ({ params, set }) => {
      const existing = WorkspaceRepository.getById(params.id);
      if (!existing) {
        throw new NotFoundError("Workspace", params.id);
      }

      log.info({ workspaceId: params.id }, "Deleting workspace");
      WorkspaceRepository.delete(params.id);
      set.status = 204;
      return null;
    },
    {
      params: t.Object({ id: t.String() }),
    },
  );
