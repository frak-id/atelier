/**
 * `/api/*` — control CRUD (atelier-v2 §3.1 api/ table: "/api/* → control
 * CRUD"). Identity, orgs, secrets, org policy. Thin Elysia
 * binding; all policy logic lives in `control/`.
 */
import {
  ToolboxConfigInputSchema,
  ToolboxConfigPatchSchema,
  ToolboxVersionCaptureRequestSchema,
} from "@atelier/spec";
import { Elysia, t } from "elysia";
import { type ControlContainer, recipeFingerprint } from "../control/index.ts";
import { ConflictError, ValidationError } from "../shared/errors.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import { createAuthPlugin } from "./auth.plugin.ts";
import { pruneToolboxVersions, type ServerContainer } from "./container.ts";
import { requireToolboxOwnerAccess, resolveOwner } from "./toolbox-access.ts";

const log = createChildLogger("control-routes");

/** Soft cap on enabled toolboxes per org — a boot-latency tradeoff, not a
 * hard limit (R10). */
const TOOLBOX_SOFT_CAP = 5;

const OrgRoleSchema = t.Union([
  t.Literal("owner"),
  t.Literal("admin"),
  t.Literal("member"),
  t.Literal("viewer"),
]);

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
  policy: TransferIdsSchema,
  toolboxes: TransferIdsSchema,
  starters: TransferIdsSchema,
});

/**
 * AuthZ for an ownership transfer: owner/admin of the source org (or the
 * caller's own personal scope — `resolveOwner` with write access) AND of the
 * target org. A non-member gets 403 for an org that doesn't exist, too.
 */
function authorizeTransfer(
  control: ControlContainer,
  userId: string,
  fromParam: string,
  toOrgId: string,
) {
  const from = resolveOwner(control, userId, fromParam, true);
  control.orgMemberService.requireRole(toOrgId, userId, ["owner", "admin"]);
  return { from, toOrgId };
}

export function createControlRoutes(container: ServerContainer) {
  const { control, jobs } = container;
  const authPlugin = createAuthPlugin(control);

  // Bearer-authenticated identity echo (unlike `/auth/me`, which is
  // cookie/JWT-only) so CLI/API-key callers can resolve who they are.
  const meRoutes = new Elysia({ prefix: "/me" })
    .use(authPlugin)
    .get("/", ({ user }) => ({
      id: user.id,
      username: user.username,
      email: user.email,
      avatarUrl: user.avatarUrl,
      organizations: control.organizationService.getByUserId(user.id),
    }));

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

  // Move owner-scoped records (org secrets + policy, toolboxes, Launchpad
  // starters) from an org or the caller's personal scope into an org.
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
        const { from, toOrgId } = authorizeTransfer(
          control,
          user.id,
          query.from,
          query.to,
        );
        return control.ownershipTransferService.preview(
          from,
          toOrgId,
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
        const { from, toOrgId } = authorizeTransfer(
          control,
          user.id,
          body.from,
          body.to,
        );
        return control.ownershipTransferService.execute(
          from,
          toOrgId,
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
    // The caller's orgs + role. `mine` flags THEIR personal org (the spawn
    // default) — `personal` alone can't: someone else's personal org they
    // were invited to is personal too.
    .get("/", ({ user }) => {
      const personalOrgId = control.userService.getById(user.id)?.personalOrgId;
      return control.organizationService
        .getByUserId(user.id)
        .map((org) => ({ ...org, mine: org.id === personalOrgId }));
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
        control.orgMemberService.requireRole(params.id, user.id, [
          "owner",
          "admin",
        ]);
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
      control.orgMemberService.requireRole(params.id, user.id, ["owner"]);
      const owned = control.ownershipTransferService.inventory({
        type: "org",
        id: params.id,
      });
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

  const secretRoutes = new Elysia({ prefix: "/secrets" })
    .use(authPlugin)
    .get("/", ({ query }) => control.secretService.list(query.orgId), {
      query: t.Object({ orgId: t.Optional(t.String()) }),
    })
    .post(
      "/",
      ({ body }) =>
        control.secretService.set(body.orgId, body.name, body.value),
      {
        body: t.Object({
          orgId: t.Optional(t.String()),
          name: t.String({ minLength: 1 }),
          value: t.String(),
        }),
      },
    )
    .delete("/:id", ({ params, set }) => {
      control.secretService.delete(params.id);
      set.status = 204;
    });

  const toolboxRoutes = new Elysia({ prefix: "/toolboxes" })
    .use(authPlugin)
    .get(
      "/",
      ({ user, query }) => {
        const owner = resolveOwner(control, user.id, query.owner, false);
        return control.toolboxService.list(owner);
      },
      { query: t.Object({ owner: t.Optional(t.String()) }) },
    )
    .post(
      "/",
      ({ user, query, body }) => {
        const owner = resolveOwner(control, user.id, query.owner, true);
        const created = control.toolboxService.create(owner, body);
        const autoInjectCount =
          control.toolboxService.listAutoInject(owner).length;
        if (autoInjectCount > TOOLBOX_SOFT_CAP) {
          log.warn(
            { ownerType: owner.type, ownerId: owner.id, autoInjectCount },
            `${owner.type} exceeds the soft cap of ${TOOLBOX_SOFT_CAP} auto-inject toolboxes — each adds boot latency to every spawn`,
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
        requireToolboxOwnerAccess(control, existing, user.id);
        return control.toolboxService.update(params.id, body);
      },
      { body: ToolboxConfigPatchSchema },
    )
    .delete("/:id", ({ user, params, set }) => {
      const existing = control.toolboxService.get(params.id);
      requireToolboxOwnerAccess(control, existing, user.id);
      control.toolboxService.delete(params.id);
      set.status = 204;
    })
    .post(
      "/:id/versions/capture",
      ({ user, params, body, set }) => {
        const tb = control.toolboxService.get(params.id);
        requireToolboxOwnerAccess(control, tb, user.id);
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
                name: `tb/${tb.ownerType}/${tb.ownerId}/${tb.slug}`,
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
    .get("/:id/versions", async ({ user, params }) => {
      const tb = control.toolboxService.get(params.id);
      requireToolboxOwnerAccess(control, tb, user.id);
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
        requireToolboxOwnerAccess(control, tb, user.id);
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
        if (tb.ownerType === "org") {
          const entry = container.runtime.getToolsetEntry(version.ref);
          if (entry?.private === true) {
            throw new ValidationError(
              "publish this toolset before pinning an org toolbox org-wide",
            );
          }
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
      requireToolboxOwnerAccess(control, tb, user.id);
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
      requireToolboxOwnerAccess(control, tb, user.id);
      if (
        control.toolboxService.getActiveVersionId(tb.id) === params.versionId
      ) {
        throw new ValidationError(
          "cannot delete the active version; unpin first",
        );
      }
      control.toolboxVersionService.delete(params.versionId);
      set.status = 204;
    });

  // Server-wide runtime config (the config plane). Not org-scoped: these are
  // operator knobs for the whole server. Auth-gated (any authenticated caller
  // can read/set today — there is no server-admin role yet; tighten here once
  // one exists).
  const configRoutes = new Elysia({ prefix: "/config" })
    .use(authPlugin)
    .get("/", () => control.serverConfigService.list())
    .put(
      "/:key",
      ({ params, body }) => {
        const value = control.serverConfigService.set(params.key, body.value);
        return { key: params.key, value };
      },
      {
        body: t.Object({
          value: t.Union([t.Boolean(), t.Number(), t.String()]),
        }),
      },
    );

  const orgPolicyRoutes = new Elysia({ prefix: "/org-policy" })
    .use(authPlugin)
    .get("/:orgId", ({ params }) =>
      control.orgPolicyService.getByOrgId(params.orgId),
    )
    .put(
      "/:orgId",
      ({ user, params, body }) => {
        control.orgMemberService.requireRole(params.orgId, user.id, ["owner"]);
        return control.orgPolicyService.set(params.orgId, body);
      },
      { body: t.Record(t.String(), t.Unknown()) },
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
    .use(meRoutes)
    .use(apiKeyRoutes)
    .use(sshKeyRoutes)
    .use(userRoutes)
    .use(organizationRoutes)
    .use(transferRoutes)
    .use(secretRoutes)
    .use(configRoutes)
    .use(orgPolicyRoutes)
    .use(toolboxRoutes)
    .use(githubRoutes);
}
