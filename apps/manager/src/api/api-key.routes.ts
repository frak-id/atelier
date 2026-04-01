import { Elysia } from "elysia";
import { apiKeyService } from "../container.ts";
import {
  ApiKeyListResponseSchema,
  CreateApiKeyBodySchema,
  CreateApiKeyResponseSchema,
  IdParamSchema,
} from "../schemas/index.ts";
import { authPlugin } from "../shared/lib/auth.ts";

export const apiKeyRoutes = new Elysia({ prefix: "/api-keys" })
  .use(authPlugin)
  .get(
    "/",
    ({ user }) => {
      return apiKeyService.listByUser(user.id);
    },
    {
      response: ApiKeyListResponseSchema,
    },
  )
  .post(
    "/",
    ({ body, user }) => {
      const { apiKey, rawKey } = apiKeyService.create(
        user.id,
        body.name,
        body.expiresAt,
      );
      return { apiKey, rawKey };
    },
    {
      body: CreateApiKeyBodySchema,
      response: CreateApiKeyResponseSchema,
    },
  )
  .delete(
    "/:id",
    ({ params, user, set }) => {
      apiKeyService.delete(params.id, user.id);
      set.status = 204;
    },
    {
      params: IdParamSchema,
    },
  );
