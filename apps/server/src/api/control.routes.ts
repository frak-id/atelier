/**
 * `/api/*` — control CRUD (docs/archive/design.md §3.1 api/ table: "/api/* → control
 * CRUD"). Identity, orgs, secrets, toolboxes. Thin Elysia
 * binding; all policy logic lives in `control/`.
 */
import {
  ToolboxConfigInputSchema,
  ToolboxConfigPatchSchema,
  ToolboxVersionCaptureRequestSchema,
} from "@atelier/spec";
import { Elysia, t } from "elysia";
import { recipeFingerprint } from "../control/index.ts";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../shared/errors.ts";
import { isAuthBypassed } from "../shared/lib/config.ts";
import { createAuthPlugin } from "./auth.plugin.ts";
import type { ServerContainer } from "./container.ts";
import { resolveToolboxOrg } from "./toolbox-access.ts";
import { startToolboxRefresh } from "./toolbox-refresh.ts";

const OrgRoleSchema = t.Union([t.Literal("owner"), t.Literal("member")]);

const OrgSlugSchema = t.String({
  minLength: 1,
  maxLength: 50,
  pattern: "^[a-z0-9-]+$",
});

const TransferIdsSchema = t.Array(t.String({ minLength: 1 }), {
  maxItems: 500,
});
/** Ids to move, per kind (mirrors control's `TransferSelection`). */
const TransferSelectionSchema = t.Object({
  secrets: TransferIdsSchema,
  toolboxes: TransferIdsSchema,
});

export function createControlRoutes(container: ServerContainer) {
  const { control } = container;
  const authPlugin = createAuthPlugin(control);

  const apiKeyRoutes = new Elysia({ prefix: "/api-keys" })
    .use(authPlugin)
    .get("/", ({ user }) => control.apiKeyService.listByUser(user.id))
    .post(
      "/",
      ({ user, body }) =>
        control.apiKeyService.create(user.id, body.name, body.expiresAt),
      {
        body: t.Object({
          name: t.String({ minLength: 1, maxLength: 100 }),
          expiresAt: t.Optional(t.String()),
        }),
      },
    )
    .delete("/:id", ({ user, params, set }) => {
      control.apiKeyService.delete(params.id, user.id);
      set.status = 204;
    });

  const sshKeyRoutes = new Elysia({ prefix: "/ssh-keys" })
    .use(authPlugin)
    .get("/", ({ user }) => control.sshKeyService.listByUserId(user.id))
    .post(
      "/",
      ({ user, body }) =>
        control.sshKeyService.create({
          ...body,
          userId: user.id,
          username: user.username,
        }),
      {
        body: t.Object({
          publicKey: t.String({ minLength: 1 }),
          name: t.String({ minLength: 1, maxLength: 100 }),
          type: t.Union([t.Literal("generated"), t.Literal("uploaded")]),
          expiresAt: t.Optional(t.String()),
        }),
      },
    )
    .delete("/:id", ({ user, params, set }) => {
      control.sshKeyService.delete(params.id, user.id);
      set.status = 204;
    });

  // The user directory: every registered user + their org memberships
  // (never tokens). Readable by any authenticated caller — the platform is
  // already gated to an allowlist/GitHub org, and the add-member picker
  // needs it. Backs the console's Users page.
  const userRoutes = new Elysia({ prefix: "/users" })
    .use(authPlugin)
    .get("/", () => control.userService.listDirectory());

  // Move an org's secrets and toolboxes into another org (the caller's
  // personal org is the usual source).
  const transferRoutes = new Elysia({ prefix: "/transfers" })
    .use(authPlugin)
    .get(
      "/preview",
      ({ user, query }) => {
        return container.toolboxOps.previewTransfer(
          user.id,
          query.from,
          query.to,
        );
      },
      {
        query: t.Object({
          from: t.String({ minLength: 1 }),
          to: t.String({ minLength: 1 }),
        }),
      },
    )
    .post(
      "/",
      ({ user, body }) => {
        return container.toolboxOps.transfer(
          user.id,
          body.from,
          body.to,
          body.selection,
        );
      },
      {
        body: t.Object({
          from: t.String({ minLength: 1 }),
          to: t.String({ minLength: 1 }),
          selection: TransferSelectionSchema,
        }),
      },
    );

  const organizationRoutes = new Elysia({ prefix: "/organizations" })
    .use(authPlugin)
    // The caller's orgs + role. `mine` flags THEIR personal org —
    // `personal` alone can't: someone else's personal org they were invited
    // to is personal too. `default` flags the team org (`auth.defaultOrg`),
    // the spawn picker's default.
    .get("/", ({ user }) => {
      const personalOrgId = control.userService.getById(user.id)?.personalOrgId;
      const defaultOrgId = control.defaultOrg.defaultOrgId();
      return control.organizationService.getByUserId(user.id).map((org) => ({
        ...org,
        mine: org.id === personalOrgId,
        default: org.id === defaultOrgId,
      }));
    })
    .post(
      "/",
      ({ user, body }) => {
        // Resolve the caller before creating: a failing `addMember` after the
        // insert would leave an org nobody belongs to.
        control.userService.getByIdOrThrow(user.id);
        if (control.organizationService.getBySlug(body.slug)) {
          throw new ConflictError(`Slug '${body.slug}' is taken`);
        }
        const org = control.organizationService.create(body.name, body.slug);
        control.orgMemberService.addMember(org.id, user.id, "owner");
        // Default toolbox seeding disabled for now (created explicitly).
        return org;
      },
      {
        body: t.Object({
          name: t.String({ minLength: 1, maxLength: 100 }),
          slug: OrgSlugSchema,
        }),
      },
    )
    .patch(
      "/:id",
      ({ user, params, body }) => {
        control.orgMemberService.requireOwner(params.id, user.id);
        return control.organizationService.rename(params.id, body);
      },
      {
        body: t.Object({
          name: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
          slug: t.Optional(OrgSlugSchema),
        }),
      },
    )
    .delete("/:id", ({ user, params, set }) => {
      control.orgMemberService.requireOwner(params.id, user.id);
      const owned = control.ownershipTransferService.inventory(params.id);
      const leftovers = Object.entries(owned)
        .filter(([, count]) => count > 0)
        .map(([kind, count]) => `${count} ${kind}`);
      if (leftovers.length > 0) {
        throw new ConflictError(
          `This organization still owns ${leftovers.join(", ")}: move or delete them first`,
        );
      }
      control.organizationService.delete(params.id);
      set.status = 204;
    })
    .get("/:id/members", ({ user, params }) => {
      control.orgMemberService.requireMembership(params.id, user.id);
      return control.orgMemberService.getByOrgId(params.id);
    })
    .patch(
      "/:id/members/:userId",
      ({ user, params, body }) =>
        control.orgMemberService.updateRole(
          params.id,
          user.id,
          params.userId,
          body.role,
        ),
      { body: t.Object({ role: OrgRoleSchema }) },
    )
    // Remove a member, or leave the org (`:userId` = the caller).
    .delete("/:id/members/:userId", ({ user, params, set }) => {
      control.orgMemberService.removeMember(params.id, user.id, params.userId);
      set.status = 204;
    })
    .post(
      "/:id/members",
      ({ user, params, body }) =>
        control.orgMemberService.inviteMember(
          params.id,
          user.id,
          body.userId,
          body.role,
        ),
      {
        body: t.Object({
          userId: t.String({ minLength: 1 }),
          role: t.Optional(OrgRoleSchema),
        }),
      },
    );

  // Org secrets: list = any member, set/delete = owner. Global
  // (org-less) secrets hold server-owned values (e.g. the SSH gateway host
  // key), so they are server-managed — manageable over the API only when auth
  // is bypassed (local single-user mode).
  const requireSecretAccess = (
    userId: string,
    orgId: string | undefined,
    write: boolean,
  ) => {
    if (!orgId) {
      if (!isAuthBypassed()) {
        throw new ForbiddenError("Global secrets are server-managed");
      }
    } else if (write) {
      control.orgMemberService.requireOwner(orgId, userId);
    } else {
      control.orgMemberService.requireMembership(orgId, userId);
    }
  };

  const secretRoutes = new Elysia({ prefix: "/secrets" })
    .use(authPlugin)
    .get(
      "/",
      ({ user, query }) => {
        requireSecretAccess(user.id, query.orgId, false);
        return control.secretService.list(query.orgId);
      },
      {
        query: t.Object({ orgId: t.Optional(t.String()) }),
      },
    )
    .post(
      "/",
      ({ user, body }) => {
        requireSecretAccess(user.id, body.orgId, true);
        return control.secretService.set(body.orgId, body.name, body.value);
      },
      {
        body: t.Object({
          orgId: t.Optional(t.String()),
          name: t.String({ minLength: 1 }),
          value: t.String(),
        }),
      },
    )
    .delete("/:id", ({ user, params, set }) => {
      const secret = control.secretService.getById(params.id);
      // A secret of an org the caller isn't in is reported as unknown (404),
      // not 403, so ids of foreign orgs' secrets don't leak.
      if (
        secret.orgId &&
        !control.orgMemberService.getMembership(secret.orgId, user.id)
      ) {
        throw new NotFoundError("Secret", params.id);
      }
      requireSecretAccess(user.id, secret.orgId, true);
      control.secretService.delete(params.id);
      set.status = 204;
    });

  const { toolboxOps } = container;
  const toolboxRoutes = new Elysia({ prefix: "/toolboxes" })
    .use(authPlugin)
    .get(
      "/",
      ({ user, query }) =>
        control.toolboxService.list(
          resolveToolboxOrg(control, user.id, query.owner),
        ),
      { query: t.Object({ owner: t.Optional(t.String()) }) },
    )
    .post(
      "/",
      ({ user, query, body }) => toolboxOps.create(user.id, query.owner, body),
      {
        query: t.Object({ owner: t.Optional(t.String()) }),
        body: ToolboxConfigInputSchema,
      },
    )
    .patch(
      "/:id",
      ({ user, params, body }) => toolboxOps.update(user.id, params.id, body),
      { body: ToolboxConfigPatchSchema },
    )
    .delete("/:id", ({ user, params, set }) => {
      toolboxOps.delete(user.id, params.id);
      set.status = 204;
    })
    // Capture is a long op: a `202` job whose result is the saved version.
    .post(
      "/:id/versions/capture",
      ({ user, params, body, set }) => {
        const job = toolboxOps.startCapture(user.id, params.id, body);
        set.status = 202;
        return job;
      },
      { body: ToolboxVersionCaptureRequestSchema },
    )
    // Refresh (docs/toolbox-versions.md section 10): run the toolbox's update
    // commands over its current version in a throwaway pod, save the paths
    // as a new version and pin it. A `202` job, or the one already running
    // for this toolbox.
    .post("/:id/refresh", ({ user, params, set }) => {
      const tb = toolboxOps.authorize(user.id, params.id);
      const { job } = startToolboxRefresh(container, tb.id, {
        trigger: "manual",
        userId: user.id,
      });
      set.status = 202;
      return job;
    })
    .get("/:id/versions", async ({ user, params }) => {
      const tb = toolboxOps.authorize(user.id, params.id);
      const currentSourceImage = await container.runtime
        .resolveSourceImage(
          tb.source ?? { image: container.runtime.defaultImage() },
        )
        .catch(() => undefined);
      return {
        // Each version with its artifact's sharing state + path-sets (a
        // runtime fact) so the console can offer an informed Publish.
        versions: control.toolboxVersionService
          .listByToolbox(tb.id)
          .map((version) => {
            const entry = container.runtime.getToolsetEntry(version.ref);
            return {
              ...version,
              artifact: entry
                ? { private: entry.private === true, paths: entry.paths }
                : null,
            };
          }),
        activeVersionId: control.toolboxService.getActiveVersionId(tb.id),
        currentRecipeFingerprint: recipeFingerprint(tb),
        ...(currentSourceImage ? { currentSourceImage } : {}),
      };
    })
    .put(
      "/:id/active-version",
      ({ user, params, body }) => ({
        activeVersionId: toolboxOps.pin(user.id, params.id, body.versionId),
      }),
      {
        body: t.Object({
          versionId: t.Union([t.String(), t.Null()]),
        }),
      },
    )
    // Mark a version's artifact as shareable (flip `private` off). Same
    // bytes, same digest: publishing never changes what a pin replays. Scoped
    // to the toolbox's owner, unlike the raw `POST /v1/toolsets/publish`.
    .post("/:id/versions/:versionId/publish", ({ user, params }) =>
      toolboxOps.publish(user.id, params.id, params.versionId),
    )
    .delete("/:id/versions/:versionId", ({ user, params, set }) => {
      toolboxOps.deleteVersion(user.id, params.id, params.versionId);
      set.status = 204;
    });

  // Server-wide runtime config (the config plane). Not org-scoped: these are
  // operator knobs for the whole server. Any member can read; setting is for
  // server admins (owners of the default org).
  const configRoutes = new Elysia({ prefix: "/config" })
    .use(authPlugin)
    .get("/", () => control.serverConfigService.list())
    .put(
      "/:key",
      ({ user, params, body }) => {
        control.defaultOrg.requireServerAdmin(user.id);
        const value = control.serverConfigService.set(params.key, body.value);
        return { key: params.key, value };
      },
      {
        body: t.Object({
          value: t.Union([t.Boolean(), t.Number(), t.String()]),
        }),
      },
    );

  // The caller's GitHub repositories (their OWN OAuth token, never another
  // user's): the console's quick-prebuild picker lists them, and `inspect`
  // prefills the create form with branches + detected setup steps.
  const githubRoutes = new Elysia({ prefix: "/github" })
    .use(authPlugin)
    .get(
      "/repos",
      ({ user, query }) =>
        control.gitHubRepoService.listRepos(user.id, {
          refresh: query.refresh === true,
        }),
      { query: t.Object({ refresh: t.Optional(t.Boolean()) }) },
    )
    .get(
      "/repos/:owner/:name",
      ({ user, params, query }) =>
        control.gitHubRepoService.inspectRepo(
          user.id,
          params.owner,
          params.name,
          query.ref,
        ),
      {
        params: t.Object({ owner: t.String(), name: t.String() }),
        query: t.Object({ ref: t.Optional(t.String()) }),
      },
    );

  return new Elysia({ prefix: "/api" })
    .use(apiKeyRoutes)
    .use(sshKeyRoutes)
    .use(userRoutes)
    .use(organizationRoutes)
    .use(transferRoutes)
    .use(secretRoutes)
    .use(configRoutes)
    .use(toolboxRoutes)
    .use(githubRoutes);
}
