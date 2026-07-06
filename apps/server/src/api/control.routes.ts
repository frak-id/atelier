/**
 * `/api/*` — control CRUD (atelier-v2 §3.1 api/ table: "/api/* → control
 * CRUD"). Identity, orgs, saved specs, secrets, org policy. Thin Elysia
 * binding; all policy logic lives in `control/`.
 */
import type { SandboxSpec, ToolboxOwner } from "@atelier/spec";
import {
  SandboxSpecSchema,
  ToolboxConfigInputSchema,
  ToolboxConfigPatchSchema,
} from "@atelier/spec";
import { Elysia, t } from "elysia";
import { ForbiddenError, ValidationError } from "../shared/errors.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import { createAuthPlugin } from "./auth.plugin.ts";
import type { ServerContainer } from "./container.ts";

const log = createChildLogger("control-routes");

/** Soft cap on enabled toolboxes per org — a boot-latency tradeoff, not a
 * hard limit (R10). */
const TOOLBOX_SOFT_CAP = 5;

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

  const organizationRoutes = new Elysia({ prefix: "/organizations" })
    .use(authPlugin)
    .get("/", ({ user }) => control.organizationService.getByUserId(user.id))
    .post(
      "/",
      ({ user, body }) => {
        const org = control.organizationService.create(body.name, body.slug);
        control.orgMemberService.addMember(org.id, user.id, "owner");
        // Default toolbox seeding disabled for now (created explicitly).
        return org;
      },
      {
        body: t.Object({
          name: t.String({ minLength: 1, maxLength: 100 }),
          slug: t.String({
            minLength: 1,
            maxLength: 50,
            pattern: "^[a-z0-9-]+$",
          }),
        }),
      },
    )
    .get("/:id/members", ({ params }) =>
      control.orgMemberService.getByOrgId(params.id),
    )
    .post(
      "/:id/members",
      ({ user, params, body }) => {
        control.orgMemberService.requireRole(params.id, user.id, [
          "owner",
          "admin",
        ]);
        return control.orgMemberService.addMember(
          params.id,
          body.userId,
          body.role,
        );
      },
      {
        body: t.Object({
          userId: t.String({ minLength: 1 }),
          role: t.Optional(
            t.Union([
              t.Literal("owner"),
              t.Literal("admin"),
              t.Literal("member"),
              t.Literal("viewer"),
            ]),
          ),
        }),
      },
    );

  const savedSpecRoutes = new Elysia({ prefix: "/saved-specs" })
    .use(authPlugin)
    .get("/", ({ user }) => {
      const orgIds = control.orgMemberService
        .getByUserId(user.id)
        .map((m) => m.orgId);
      return control.savedSpecService.getByOrgIds(orgIds);
    })
    .get("/:id", ({ params }) =>
      control.savedSpecService.getByIdOrThrow(params.id),
    )
    .post(
      "/",
      ({ body }) =>
        control.savedSpecService.create(
          body.name,
          body.spec as SandboxSpec,
          body.orgId,
        ),
      {
        body: t.Object({
          name: t.String({ minLength: 1 }),
          spec: SandboxSpecSchema,
          orgId: t.Optional(t.String()),
        }),
      },
    )
    .patch(
      "/:id",
      ({ params, body }) =>
        control.savedSpecService.update(params.id, {
          name: body.name,
          spec: body.spec as SandboxSpec | undefined,
        }),
      {
        body: t.Object({
          name: t.Optional(t.String()),
          spec: t.Optional(SandboxSpecSchema),
        }),
      },
    )
    .delete("/:id", ({ params, set }) => {
      control.savedSpecService.delete(params.id);
      set.status = 204;
    });

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

  /**
   * Parse + authorize the `?owner=` scope for a GET/POST toolbox request.
   * Grammar: `org:<id>` | `user:<id>` | `user` | `me` (alias for the caller).
   * Absent → default to the caller (`user:<me>`) — the "My Toolboxes" home;
   * we do NOT fall back to an org, so an org's private build scripts are never
   * the implicit default (entities-toolbox.md D7).
   *
   * AuthZ per owner type: org → `requireRole(owner/admin)` (write) or
   * `requireMembership` (read); user → self-only (a user may only ever scope
   * to their own id).
   */
  function resolveOwner(
    userId: string,
    ownerParam: string | undefined,
    write: boolean,
  ): ToolboxOwner {
    if (!ownerParam || ownerParam === "me" || ownerParam === "user") {
      return { type: "user", id: userId };
    }
    const [type, id] = ownerParam.split(":", 2);
    if (type === "user") {
      const targetId = !id || id === "me" ? userId : id;
      if (targetId !== userId) {
        throw new ForbiddenError("Cannot access another user's toolboxes");
      }
      return { type: "user", id: userId };
    }
    if (type === "org") {
      if (!id) throw new ValidationError("owner=org: requires an org id");
      if (write) {
        control.orgMemberService.requireRole(id, userId, ["owner", "admin"]);
      } else {
        control.orgMemberService.requireMembership(id, userId);
      }
      return { type: "org", id };
    }
    throw new ValidationError(`Invalid owner scope '${ownerParam}'`);
  }

  /**
   * Authorize a mutation against the STORED record's owner (never a caller-
   * supplied scope) — the security-critical spot for PATCH/DELETE. Org →
   * owner/admin of the record's org; user → the record's owner only (org
   * admins do NOT manage members' personal toolboxes).
   */
  function requireToolboxOwnerAccess(
    toolbox: { ownerType: ToolboxOwner["type"]; ownerId: string },
    userId: string,
  ): void {
    if (toolbox.ownerType === "org") {
      control.orgMemberService.requireRole(toolbox.ownerId, userId, [
        "owner",
        "admin",
      ]);
      return;
    }
    if (toolbox.ownerType === "user") {
      if (toolbox.ownerId !== userId) {
        throw new ForbiddenError("Cannot manage another user's toolbox");
      }
      return;
    }
    // Fail closed on any unexpected owner type (defense-in-depth: the typed
    // service layer should make this unreachable).
    throw new ForbiddenError("Unknown toolbox owner");
  }

  const toolboxRoutes = new Elysia({ prefix: "/toolboxes" })
    .use(authPlugin)
    .get(
      "/",
      ({ user, query }) => {
        const owner = resolveOwner(user.id, query.owner, false);
        return control.toolboxService.list(owner);
      },
      { query: t.Object({ owner: t.Optional(t.String()) }) },
    )
    .post(
      "/",
      ({ user, query, body }) => {
        const owner = resolveOwner(user.id, query.owner, true);
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
        requireToolboxOwnerAccess(existing, user.id);
        return control.toolboxService.update(params.id, body);
      },
      { body: ToolboxConfigPatchSchema },
    )
    .delete("/:id", ({ user, params, set }) => {
      const existing = control.toolboxService.get(params.id);
      requireToolboxOwnerAccess(existing, user.id);
      control.toolboxService.delete(params.id);
      set.status = 204;
    });

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

  return new Elysia({ prefix: "/api" })
    .use(apiKeyRoutes)
    .use(sshKeyRoutes)
    .use(organizationRoutes)
    .use(savedSpecRoutes)
    .use(secretRoutes)
    .use(orgPolicyRoutes)
    .use(toolboxRoutes);
}
