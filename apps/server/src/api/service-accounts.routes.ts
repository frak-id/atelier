/**
 * `/api/service-accounts`: the admin routes of service accounts, non-human
 * users agents act as (see `control/modules/service-account/`). Server admins
 * only, every route: a service account never manages itself, and none of its
 * keys opens these (the lockout is the admin check plus the `mcp` key scope).
 */
import { Elysia, t } from "elysia";
import { GitHubAppError, type ServiceAccount } from "../control/index.ts";
import { ConflictError, SandboxError } from "../shared/errors.ts";
import { OWNER_ID_METADATA } from "../shared/lib/git-attribution.ts";
import { createAuthPlugin } from "./auth.plugin.ts";
import type { ServerContainer } from "./container.ts";

const RoleSchema = t.Union([t.Literal("owner"), t.Literal("member")]);
const ScopeSchema = t.Union([t.Literal("full"), t.Literal("mcp")]);

const GitHubInputSchema = t.Union([
  t.Object({
    kind: t.Literal("app"),
    appId: t.Union([t.String(), t.Number()]),
    installationId: t.Union([t.String(), t.Number()]),
    // Optional on update: the stored key is kept.
    privateKey: t.Optional(t.String()),
    repositories: t.Optional(t.Array(t.String(), { minItems: 1 })),
    permissions: t.Optional(t.Record(t.String(), t.String())),
  }),
  t.Object({
    kind: t.Literal("token"),
    // Optional on update: the stored token is kept.
    token: t.Optional(t.String()),
    gitName: t.String(),
    gitEmail: t.String(),
  }),
]);

const NameSchema = t.String({ minLength: 1, maxLength: 100 });

export function createServiceAccountRoutes(container: ServerContainer) {
  const { control, runtime } = container;
  const { serviceAccountService: accounts, defaultOrg } = control;

  const sandboxCounts = (): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const sandbox of runtime.list()) {
      const owner = sandbox.metadata?.[OWNER_ID_METADATA];
      if (owner) counts.set(owner, (counts.get(owner) ?? 0) + 1);
    }
    return counts;
  };

  const present = (sa: ServiceAccount, counts: Map<string, number>) => {
    const org = control.organizationService.getById(sa.orgId);
    return {
      ...sa,
      role: accounts.roleOf(sa) ?? null,
      org: org ? { id: org.id, name: org.name, slug: org.slug } : null,
      sandboxCount: counts.get(sa.id) ?? 0,
    };
  };

  return (
    new Elysia({ prefix: "/api/service-accounts" })
      .use(createAuthPlugin(control))
      .onBeforeHandle(({ user }) => defaultOrg.requireServerAdmin(user.id))
      .get("/", () => {
        const counts = sandboxCounts();
        return accounts.list().map((sa) => present(sa, counts));
      })
      .post(
        "/",
        ({ user, body }) => {
          const sa = accounts.create({ ...body, createdBy: user.id });
          return present(sa, sandboxCounts());
        },
        {
          body: t.Object({
            name: t.String({ minLength: 1, maxLength: 39 }),
            description: t.Optional(t.String({ maxLength: 500 })),
            orgId: t.String({ minLength: 1 }),
            role: t.Optional(RoleSchema),
            github: t.Optional(GitHubInputSchema),
          }),
        },
      )
      .get("/:id", ({ params }) =>
        present(accounts.get(params.id), sandboxCounts()),
      )
      .patch(
        "/:id",
        ({ params, body }) =>
          present(accounts.update(params.id, body), sandboxCounts()),
        {
          body: t.Object({
            description: t.Optional(t.String({ maxLength: 500 })),
            orgId: t.Optional(t.String({ minLength: 1 })),
            role: t.Optional(RoleSchema),
            // `null` removes the credential.
            github: t.Optional(t.Union([GitHubInputSchema, t.Null()])),
          }),
        },
      )
      .delete("/:id", ({ params, set }) => {
        const sa = accounts.get(params.id);
        const owned = sandboxCounts().get(sa.id) ?? 0;
        if (owned > 0) {
          throw new ConflictError(
            `Service account '${sa.name}' still owns ${owned} sandbox${owned === 1 ? "" : "es"}: destroy its ${owned} sandbox${owned === 1 ? "" : "es"} first`,
          );
        }
        // A create still resolving its prebuild has no sandbox record yet.
        const creating = container.jobs.findActive(
          (job) =>
            job.kind === "sandbox-create" && job.metadata?.owner === sa.id,
        );
        if (creating) {
          throw new ConflictError(
            `Service account '${sa.name}' is still creating a sandbox: wait for it, then delete the account`,
          );
        }
        accounts.delete(params.id);
        set.status = 204;
      })
      .get("/:id/api-keys", ({ params }) => accounts.listKeys(params.id))
      // The raw key is in this response only: it is stored as a hash.
      .post(
        "/:id/api-keys",
        ({ params, body }) => accounts.createKey(params.id, body),
        {
          body: t.Object({
            name: NameSchema,
            expiresAt: t.Optional(t.String()),
            scope: t.Optional(ScopeSchema),
          }),
        },
      )
      .delete("/:id/api-keys/:keyId", ({ params, set }) => {
        accounts.revokeKey(params.id, params.keyId);
        set.status = 204;
      })
      // "Test connection": mint a fresh installation token with the stored
      // App credential and report the bot identity and what the token can
      // do. GitHub's refusal is the answer (502 with its message).
      .post("/:id/github/check", async ({ params }) => {
        const sa = accounts.get(params.id);
        try {
          return await control.gitCredentials.check(sa.id);
        } catch (err) {
          if (err instanceof GitHubAppError) {
            throw new SandboxError(err.message, "GITHUB_APP_ERROR", 502);
          }
          throw err;
        }
      })
  );
}
