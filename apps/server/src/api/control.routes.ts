/**
 * `/api/*` — control CRUD (design.md §3.1 api/ table: "/api/* → control
 * CRUD"). Identity, orgs, secrets, toolboxes. Thin Elysia
 * binding; all policy logic lives in `control/`.
 */
import {
  ToolboxConfigInputSchema,
  ToolboxConfigPatchSchema,
  ToolboxVersionCaptureRequestSchema,
  toolboxArtifactName,
} from "@atelier/spec";
import { Elysia, t } from "elysia";
import { type ControlContainer, recipeFingerprint } from "../control/index.ts";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../shared/errors.ts";
import { isAuthBypassed } from "../shared/lib/config.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import { createAuthPlugin } from "./auth.plugin.ts";
import { pruneToolboxVersions, type ServerContainer } from "./container.ts";
import { requireSandboxAccess, requireSourceAccess } from "./sandbox-guard.ts";
import { requireToolboxAccess, resolveToolboxOrg } from "./toolbox-access.ts";
import { startToolboxRefresh } from "./toolbox-refresh.ts";

const log = createChildLogger("control-routes");

/** Soft cap on enabled toolboxes per org — a boot-latency tradeoff, not a
 * hard limit (R10). */
const TOOLBOX_SOFT_CAP = 5;

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

/**
 * AuthZ for an ownership transfer: an owner of the source org (their personal
 * org, typically) and a member of the target org: sharing a toolbox with the
 * team is open to every member. Moving secrets writes them into the target,
 * which takes an owner there. A non-member gets 403 for an org that doesn't
 * exist, too.
 */
function authorizeTransfer(
  control: ControlContainer,
  userId: string,
  fromOrgId: string,
  toOrgId: string,
  movesSecrets: boolean,
) {
  control.orgMemberService.requireOwner(fromOrgId, userId);
  if (movesSecrets) control.orgMemberService.requireOwner(toOrgId, userId);
  else control.orgMemberService.requireMembership(toOrgId, userId);
}

export function createControlRoutes(container: ServerContainer) {
  const { control, jobs } = container;
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
  const transferOptions = {
    // Same invariant as the org publish-before-pin guard on
    // `PUT /toolboxes/:id/active-version`: a private capture pinned org-wide
    // would replay one user's config (maybe secrets) into every org spawn.
    pinnedToolboxBlocker: (ref: string) =>
      container.runtime.getToolsetEntry(ref)?.private === true
        ? "its pinned version is a private capture; publish it or unpin first"
        : undefined,
  };
  const transferRoutes = new Elysia({ prefix: "/transfers" })
    .use(authPlugin)
    .get(
      "/preview",
      ({ user, query }) => {
        authorizeTransfer(control, user.id, query.from, query.to, false);
        return control.ownershipTransferService.preview(
          query.from,
          query.to,
          transferOptions,
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
        authorizeTransfer(
          control,
          user.id,
          body.from,
          body.to,
          body.selection.secrets.length > 0,
        );
        return control.ownershipTransferService.execute(
          body.from,
          body.to,
          body.selection,
          transferOptions,
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
  // is bypassed (mock/local single-user modes).
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
      ({ user, query, body }) => {
        const orgId = resolveToolboxOrg(control, user.id, query.owner);
        // The source is built over at every spawn: check it now, as the writer.
        requireSourceAccess(container, user.id, body.source);
        const created = control.toolboxService.create(orgId, body);
        const autoInjectCount =
          control.toolboxService.listAutoInject(orgId).length;
        if (autoInjectCount > TOOLBOX_SOFT_CAP) {
          log.warn(
            { orgId, autoInjectCount },
            `org exceeds the soft cap of ${TOOLBOX_SOFT_CAP} auto-inject toolboxes — each adds boot latency to every spawn`,
          );
        }
        return created;
      },
      {
        query: t.Object({ owner: t.Optional(t.String()) }),
        body: ToolboxConfigInputSchema,
      },
    )
    .patch(
      "/:id",
      ({ user, params, body }) => {
        const existing = control.toolboxService.get(params.id);
        requireToolboxAccess(control, existing, user.id);
        requireSourceAccess(container, user.id, body.source);
        return control.toolboxService.update(params.id, body);
      },
      { body: ToolboxConfigPatchSchema },
    )
    .delete("/:id", ({ user, params, set }) => {
      const existing = control.toolboxService.get(params.id);
      requireToolboxAccess(control, existing, user.id);
      control.toolboxService.delete(params.id);
      set.status = 204;
    })
    .post(
      "/:id/versions/capture",
      ({ user, params, body, set }) => {
        const tb = control.toolboxService.get(params.id);
        requireToolboxAccess(control, tb, user.id);
        // The sandbox arrives in the body, not a guarded `:id` path.
        requireSandboxAccess(container, user.id, body.sandboxId);
        if (tb.paths.length === 0) {
          throw new ValidationError("toolbox has no paths to capture");
        }
        // Long op (agent tar + secret scan + push): dispatch a durable job and
        // answer `202`. The whole flow — capture, drift probe, version-row
        // create, retention prune — runs in the job body so the version is the
        // job's result once it settles.
        const job = jobs.dispatch(
          {
            kind: "toolset-capture",
            target: tb.slug,
            metadata: { toolboxId: tb.id, sandboxId: body.sandboxId },
          },
          async (signal, log) => {
            // Server-authoritative capture inputs (docs/toolbox-versions.md §2
            // invariant): a "version" must capture the toolbox's OWN paths[]
            // to stay substitutable for the recipe-built artifact, never
            // whatever the caller passes.
            const { ref } = await container.runtime.captureToolset(
              body.sandboxId,
              {
                name: toolboxArtifactName(tb),
                paths: tb.paths,
                exclude: [],
                overrides: [],
              },
              signal,
              log,
            );
            // Best-effort drift signal (docs/toolbox-versions.md §5): the base
            // image the sandbox was actually running at capture time.
            const sourceImage = await container.runtime
              .getSandboxImage(body.sandboxId)
              .catch(() => undefined);
            // Save, don't pin — pinning is a separate, explicit call (§7).
            const version = control.toolboxVersionService.create(tb.id, {
              ref,
              description: body.description,
              provenance: {
                kind: "captured",
                capturedFrom: body.sandboxId,
                capturedBy: user.id,
                ...(sourceImage ? { sourceImage } : {}),
              },
              recipeFingerprint: recipeFingerprint(tb),
            });
            pruneToolboxVersions(container, tb.id);
            return version;
          },
        );
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
      const tb = control.toolboxService.get(params.id);
      requireToolboxAccess(control, tb, user.id);
      const { job } = startToolboxRefresh(container, tb.id, {
        trigger: "manual",
        userId: user.id,
      });
      set.status = 202;
      return job;
    })
    .get("/:id/versions", async ({ user, params }) => {
      const tb = control.toolboxService.get(params.id);
      requireToolboxAccess(control, tb, user.id);
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
      ({ user, params, body }) => {
        const tb = control.toolboxService.get(params.id);
        requireToolboxAccess(control, tb, user.id);
        if (body.versionId === null) {
          control.toolboxService.setActiveVersionId(tb.id, null);
          return { activeVersionId: null };
        }
        const version = control.toolboxVersionService.get(body.versionId);
        if (version.toolboxId !== tb.id) {
          throw new ValidationError("version does not belong to this toolbox");
        }
        // Org publish-before-pin guard (docs/toolbox-versions.md §5): a
        // private capture pinned org-wide would replay one user's config
        // (and possibly secrets) into every future spawn for the whole org.
        const entry = container.runtime.getToolsetEntry(version.ref);
        if (entry?.private === true) {
          throw new ValidationError(
            "publish this toolset before pinning a toolbox org-wide",
          );
        }
        control.toolboxService.setActiveVersionId(tb.id, version.id);
        return { activeVersionId: version.id };
      },
      {
        body: t.Object({
          versionId: t.Union([t.String(), t.Null()]),
        }),
      },
    )
    // Mark a version's artifact as shareable (flip `private` off). Same
    // bytes, same digest: publishing never changes what a pin replays. Scoped
    // to the toolbox's owner, unlike the raw `POST /v1/toolsets/publish`.
    .post("/:id/versions/:versionId/publish", ({ user, params }) => {
      const tb = control.toolboxService.get(params.id);
      requireToolboxAccess(control, tb, user.id);
      const version = control.toolboxVersionService.get(params.versionId);
      if (version.toolboxId !== tb.id) {
        throw new ValidationError("version does not belong to this toolbox");
      }
      const entry = container.runtime.publishToolset(version.ref);
      log.info(
        { toolboxId: tb.id, versionId: version.id, ref: version.ref },
        "toolbox version published",
      );
      return { versionId: version.id, private: entry.private === true };
    })
    .delete("/:id/versions/:versionId", ({ user, params, set }) => {
      const tb = control.toolboxService.get(params.id);
      requireToolboxAccess(control, tb, user.id);
      if (
        control.toolboxService.getActiveVersionId(tb.id) === params.versionId
      ) {
        throw new ValidationError(
          "cannot delete the active version; unpin first",
        );
      }
      control.toolboxVersionService.delete(tb.id, params.versionId);
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
