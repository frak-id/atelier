import { Elysia, t } from "elysia";
import { internalService } from "../container.ts";

const AuthContentSchema = t.Object({
  content: t.String(),
  updatedAt: t.String(),
  updatedBy: t.Nullable(t.String()),
});

const AuthSyncBodySchema = t.Object({
  content: t.String(),
  sandboxId: t.String(),
  updatedAt: t.Optional(t.String()),
});

const AuthSyncResponseSchema = t.Object({
  action: t.Union([
    t.Literal("updated"),
    t.Literal("unchanged"),
    t.Literal("conflict"),
  ]),
  content: t.String(),
  updatedAt: t.String(),
});

export const internalRoutes = new Elysia({ prefix: "/internal" })
  .get(
    "/auth/:provider",
    async ({ params }) => {
      const auth = await internalService.getAuth(params.provider);
      if (!auth) {
        return { content: null };
      }
      return auth;
    },
    {
      params: t.Object({
        provider: t.String(),
      }),
      response: t.Union([AuthContentSchema, t.Object({ content: t.Null() })]),
      detail: {
        tags: ["internal"],
        summary: "Get shared auth for provider",
      },
    },
  )
  .post(
    "/auth/:provider/sync",
    async ({ params, body }) => {
      return internalService.syncAuth(
        params.provider,
        body.content,
        body.sandboxId,
        body.updatedAt,
      );
    },
    {
      params: t.Object({
        provider: t.String(),
      }),
      body: AuthSyncBodySchema,
      response: AuthSyncResponseSchema,
      detail: {
        tags: ["internal"],
        summary: "Sync auth from sandbox",
      },
    },
  )
  .post(
    "/configs/sync-to-nfs",
    async () => {
      return internalService.syncConfigsToNfs();
    },
    {
      response: t.Object({
        synced: t.Number(),
      }),
      detail: {
        tags: ["internal"],
        summary: "Sync all config files to NFS",
      },
    },
  );
