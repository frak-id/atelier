import type { Static } from "elysia";
import { t } from "elysia";

export const ApiKeySchema = t.Object({
  id: t.String(),
  userId: t.String(),
  name: t.String(),
  keyPrefix: t.String(),
  createdAt: t.String(),
  lastUsedAt: t.Union([t.String(), t.Null()]),
  expiresAt: t.Union([t.String(), t.Null()]),
});
export type ApiKey = Static<typeof ApiKeySchema>;

export const CreateApiKeyBodySchema = t.Object({
  name: t.String({ minLength: 1, maxLength: 100 }),
  expiresAt: t.Optional(t.String({ format: "date-time" })),
});
export type CreateApiKeyBody = Static<typeof CreateApiKeyBodySchema>;

export const CreateApiKeyResponseSchema = t.Object({
  apiKey: ApiKeySchema,
  rawKey: t.String(),
});
export type CreateApiKeyResponse = Static<typeof CreateApiKeyResponseSchema>;

export const ApiKeyListResponseSchema = t.Array(ApiKeySchema);
export type ApiKeyListResponse = Static<typeof ApiKeyListResponseSchema>;
