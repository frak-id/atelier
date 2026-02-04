import { Elysia, t } from "elysia";
import { authSyncService } from "../container.ts";

const SharedAuthInfoSchema = t.Object({
  provider: t.String(),
  path: t.String(),
  description: t.String(),
  content: t.Nullable(t.String()),
  updatedAt: t.Nullable(t.String()),
  updatedBy: t.Nullable(t.String()),
});

const UpdateAuthBodySchema = t.Object({
  content: t.String(),
});

export const sharedAuthRoutes = new Elysia({ prefix: "/shared-auth" })
  .get(
    "/",
    () => {
      return authSyncService.listAuth();
    },
    {
      response: t.Array(SharedAuthInfoSchema),
      detail: {
        tags: ["shared-auth"],
        summary: "List all shared auth providers",
      },
    },
  )
  .get(
    "/:provider",
    async ({ params, set }) => {
      const auth = await authSyncService.getAuth(params.provider);
      if (!auth) {
        set.status = 404;
        return { error: "Auth not found" };
      }
      return auth;
    },
    {
      params: t.Object({
        provider: t.String(),
      }),
      detail: {
        tags: ["shared-auth"],
        summary: "Get shared auth for provider",
      },
    },
  )
  .put(
    "/:provider",
    ({ params, body }) => {
      return authSyncService.updateAuth(params.provider, body.content);
    },
    {
      params: t.Object({
        provider: t.String(),
      }),
      body: UpdateAuthBodySchema,
      response: SharedAuthInfoSchema,
      detail: {
        tags: ["shared-auth"],
        summary: "Update shared auth content",
      },
    },
  );
