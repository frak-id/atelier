import { Elysia } from "elysia";
import {
  orgMemberService,
  prebuildRunner,
  sandboxService,
  systemAiService,
  workspaceService,
} from "../container.ts";
import {
  CreateWorkspaceBodySchema,
  IdParamSchema,
  PrebuildCancelResponseSchema,
  PrebuildTriggerResponseSchema,
  TransferWorkspaceBodySchema,
  UpdateWorkspaceBodySchema,
  WorkspaceListResponseSchema,
  WorkspaceMatchQuerySchema,
  WorkspaceMatchResponseSchema,
  WorkspaceSchema,
} from "../schemas/index.ts";
import { ForbiddenError, NotFoundError } from "../shared/errors.ts";
import type { AuthUser } from "../shared/lib/auth.ts";
import { createChildLogger } from "../shared/lib/logger.ts";

const log = createChildLogger("workspace-routes");

export const workspaceRoutes = new Elysia({ prefix: "/workspaces" })
  .get(
    "/",
    ({ store }) => {
      const user = (store as { user: AuthUser }).user;
      const memberships = orgMemberService.getByUserId(user.id);
      const orgIds = memberships.map((m) => m.orgId);
      return workspaceService.getByOrgIds(orgIds);
    },
    {
      response: WorkspaceListResponseSchema,
    },
  )
  .get(
    "/match",
    ({ query }) => {
      const match = workspaceService.matchByRemoteUrl(query.remoteUrl);
      if (!match) {
        throw new NotFoundError(
          "Workspace matching remote URL",
          query.remoteUrl,
        );
      }
      return match;
    },
    {
      query: WorkspaceMatchQuerySchema,
      response: WorkspaceMatchResponseSchema,
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

        systemAiService.generateDescriptionInBackground(
          workspace,
          "created",
          (description) => {
            workspaceService.update(workspace.id, {
              config: { description },
            });
          },
        );
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

      const activeSandboxes = sandboxService
        .getByWorkspaceId(params.id)
        .filter((s) => s.status === "running" || s.status === "creating");
      if (activeSandboxes.length > 0) {
        set.status = 409;
        return {
          error: "Workspace has active sandboxes",
          activeSandboxIds: activeSandboxes.map((s) => s.id),
        };
      }

      log.info({ workspaceId: params.id }, "Deleting workspace");
      await prebuildRunner.cleanupStorage(params.id);
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
  .post(
    "/:id/prebuild/cancel",
    async ({ params }) => {
      const workspace = workspaceService.getById(params.id);
      if (!workspace) {
        throw new NotFoundError("Workspace", params.id);
      }

      log.info({ workspaceId: params.id }, "Cancelling prebuild");
      await prebuildRunner.cancel(params.id);

      return {
        message: "Prebuild cancelled",
        workspaceId: params.id,
        status: "none",
      };
    },
    {
      params: IdParamSchema,
      response: PrebuildCancelResponseSchema,
    },
  )
  .post(
    "/:id/generate-description",
    ({ params, set }) => {
      const workspace = workspaceService.getByIdOrThrow(params.id);

      log.info({ workspaceId: params.id }, "Triggering description generation");

      systemAiService.generateDescriptionInBackground(
        workspace,
        workspace.config.description ? "updated" : "created",
        (description) => {
          workspaceService.update(params.id, {
            config: { description },
          });
        },
      );

      set.status = 202;
      return {
        message: "Description generation triggered",
        workspaceId: params.id,
      };
    },
    {
      params: IdParamSchema,
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
  )
  .post(
    "/:id/transfer",
    ({ params, body, store }) => {
      const user = (store as { user: AuthUser }).user;
      const workspace = workspaceService.getByIdOrThrow(params.id);

      if (workspace.orgId) {
        orgMemberService.requireRole(workspace.orgId, user.id, [
          "owner",
          "admin",
        ]);
      }

      orgMemberService.requireRole(body.orgId, user.id, ["owner", "admin"]);

      if (workspace.orgId === body.orgId) {
        throw new ForbiddenError(
          "Workspace already belongs to this organization",
        );
      }

      log.info(
        { workspaceId: params.id, targetOrgId: body.orgId },
        "Transferring workspace",
      );

      return workspaceService.transfer(params.id, body.orgId);
    },
    {
      params: IdParamSchema,
      body: TransferWorkspaceBodySchema,
      response: WorkspaceSchema,
    },
  );
