import type { Static } from "elysia";
import { t } from "elysia";

export const SshKeyTypeSchema = t.Union([
  t.Literal("generated"),
  t.Literal("uploaded"),
]);
export type SshKeyType = Static<typeof SshKeyTypeSchema>;

export const SshKeySchema = t.Object({
  id: t.String(),
  userId: t.String(),
  username: t.String(),
  publicKey: t.String(),
  fingerprint: t.String(),
  name: t.String(),
  type: SshKeyTypeSchema,
  expiresAt: t.Union([t.String(), t.Null()]),
  createdAt: t.String(),
  updatedAt: t.String(),
});
export type SshKey = Static<typeof SshKeySchema>;

export const CreateSshKeyBodySchema = t.Object({
  publicKey: t.String({ minLength: 1 }),
  name: t.String({ minLength: 1, maxLength: 100 }),
  type: SshKeyTypeSchema,
  expiresAt: t.Optional(t.String()),
});
export type CreateSshKeyBody = Static<typeof CreateSshKeyBodySchema>;

export const SshKeyListResponseSchema = t.Array(SshKeySchema);
export type SshKeyListResponse = Static<typeof SshKeyListResponseSchema>;

export const HasSshKeysResponseSchema = t.Object({
  hasKeys: t.Boolean(),
});
export type HasSshKeysResponse = Static<typeof HasSshKeysResponseSchema>;
