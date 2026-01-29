import type { Static } from "elysia";
import { t } from "elysia";

export const BinaryInfoSchema = t.Object({
  id: t.String(),
  name: t.String(),
  version: t.String(),
  installed: t.Boolean(),
  sizeBytes: t.Optional(t.Number()),
  path: t.Optional(t.String()),
});
export type BinaryInfo = Static<typeof BinaryInfoSchema>;

export const BinaryListSchema = t.Array(BinaryInfoSchema);
export type BinaryList = Static<typeof BinaryListSchema>;

export const BinariesImageInfoSchema = t.Object({
  exists: t.Boolean(),
  sizeBytes: t.Optional(t.Number()),
  builtAt: t.Optional(t.String()),
});
export type BinariesImageInfoType = Static<typeof BinariesImageInfoSchema>;

export const SharedStorageStatusSchema = t.Object({
  binaries: BinaryListSchema,
  image: BinariesImageInfoSchema,
});
export type SharedStorageStatus = Static<typeof SharedStorageStatusSchema>;

export const BinaryInstallResultSchema = t.Object({
  success: t.Boolean(),
  error: t.Optional(t.String()),
});
export type BinaryInstallResult = Static<typeof BinaryInstallResultSchema>;

export const BinaryIdParamSchema = t.Object({
  id: t.String(),
});
