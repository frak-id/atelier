/**
 * `/api/*` — control CRUD (atelier-v2 §3.1 api/ table: "/api/* → control
 * CRUD"). Identity, orgs, saved specs, secrets, org policy. Thin Elysia
 * binding; all policy logic lives in `control/`.
 */
import type { SandboxSpec } from "@atelier/spec";
import { SandboxSpecSchema } from "@atelier/spec";
import { Elysia, t } from "elysia";
import { createAuthPlugin } from "./auth.plugin.ts";
import type { ServerContainer } from "./container.ts";

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
    .use(orgPolicyRoutes);
}
