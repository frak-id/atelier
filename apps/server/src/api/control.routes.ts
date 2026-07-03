/**
 * `/api/*` — control CRUD (atelier-v2 §3.1 api/ table: "/api/* → control
 * CRUD"). Identity, orgs, saved specs, secrets, org policy. Thin Elysia
 * binding; all policy logic lives in `control/`.
 */
import type { SandboxSpec } from "@atelier/spec";
import {
  SandboxSpecSchema,
  ToolboxConfigInputSchema,
  ToolboxConfigPatchSchema,
} from "@atelier/spec";
import { Elysia, t } from "elysia";
import { ValidationError } from "../shared/errors.ts";
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
        control.toolboxService.seedDefault(org.id);
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

  /** Mirrors `resolveOrgId` in `v1.routes.ts` (first membership, falling
   * back to the personal org) — duplicated locally to keep control's routes
   * independent of the /v1 module. */
  function resolveCallerOrgId(userId: string): string | undefined {
    const memberships = control.orgMemberService.getByUserId(userId);
    if (memberships[0]) return memberships[0].orgId;
    return control.userService.getById(userId)?.personalOrgId;
  }

  const toolboxRoutes = new Elysia({ prefix: "/toolboxes" })
    .use(authPlugin)
    .get(
      "/",
      ({ user, query }) => {
        const orgId = query.orgId ?? resolveCallerOrgId(user.id);
        if (!orgId) return [];
        control.orgMemberService.requireMembership(orgId, user.id);
        return control.toolboxService.list(orgId);
      },
      { query: t.Object({ orgId: t.Optional(t.String()) }) },
    )
    .post(
      "/",
      ({ user, body }) => {
        const orgId = body.orgId ?? resolveCallerOrgId(user.id);
        if (!orgId) {
          throw new ValidationError("No org to create a toolbox for");
        }
        control.orgMemberService.requireRole(orgId, user.id, [
          "owner",
          "admin",
        ]);
        const created = control.toolboxService.create(orgId, body);
        const enabledCount = control.toolboxService.listEnabled(orgId).length;
        if (enabledCount > TOOLBOX_SOFT_CAP) {
          log.warn(
            { orgId, enabledCount },
            `Org exceeds the soft cap of ${TOOLBOX_SOFT_CAP} enabled toolboxes — each adds boot latency to every spawn`,
          );
        }
        return created;
      },
      {
        body: t.Composite(
          [
            ToolboxConfigInputSchema,
            t.Object({ orgId: t.Optional(t.String()) }),
          ],
          { additionalProperties: false },
        ),
      },
    )
    .patch(
      "/:id",
      ({ user, params, body }) => {
        const existing = control.toolboxService.get(params.id);
        control.orgMemberService.requireRole(existing.orgId, user.id, [
          "owner",
          "admin",
        ]);
        return control.toolboxService.update(params.id, body);
      },
      { body: ToolboxConfigPatchSchema },
    )
    .delete("/:id", ({ user, params, set }) => {
      const existing = control.toolboxService.get(params.id);
      control.orgMemberService.requireRole(existing.orgId, user.id, [
        "owner",
        "admin",
      ]);
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
