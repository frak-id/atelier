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

export const CacheFolderInfoSchema = t.Object({
  name: t.String(),
  sizeBytes: t.Number(),
  fileCount: t.Number(),
});
export type CacheFolderInfo = Static<typeof CacheFolderInfoSchema>;

export const CacheInfoSchema = t.Object({
  totalSizeBytes: t.Number(),
  folders: t.Array(CacheFolderInfoSchema),
});
export type CacheInfo = Static<typeof CacheInfoSchema>;

export const NfsStatusSchema = t.Object({
  cacheExportExists: t.Boolean(),
  binariesExportExists: t.Boolean(),
  nfsServerRunning: t.Boolean(),
});
export type NfsStatus = Static<typeof NfsStatusSchema>;

export const SharedStorageStatusSchema = t.Object({
  nfs: NfsStatusSchema,
  binaries: BinaryListSchema,
  cache: CacheInfoSchema,
});
export type SharedStorageStatus = Static<typeof SharedStorageStatusSchema>;

export const BinaryInstallResultSchema = t.Object({
  success: t.Boolean(),
  error: t.Optional(t.String()),
});
export type BinaryInstallResult = Static<typeof BinaryInstallResultSchema>;

export const CachePurgeResultSchema = t.Object({
  success: t.Boolean(),
  freedBytes: t.Number(),
  error: t.Optional(t.String()),
});
export type CachePurgeResult = Static<typeof CachePurgeResultSchema>;

export const BinaryIdParamSchema = t.Object({
  id: t.String(),
});

export const CacheFolderParamSchema = t.Object({
  folder: t.String(),
});
