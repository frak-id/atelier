import type { Static } from "elysia";
import { t } from "elysia";

export const ConfigFileContentTypeSchema = t.Union([
  t.Literal("json"),
  t.Literal("text"),
  t.Literal("binary"),
]);
export type ConfigFileContentType = Static<typeof ConfigFileContentTypeSchema>;

export const ConfigFileScopeSchema = t.Union([
  t.Literal("global"),
  t.Literal("workspace"),
]);
export type ConfigFileScope = Static<typeof ConfigFileScopeSchema>;

export const ConfigFileSchema = t.Object({
  id: t.String(),
  path: t.String(),
  content: t.String(),
  contentType: ConfigFileContentTypeSchema,
  scope: ConfigFileScopeSchema,
  workspaceId: t.Optional(t.String()),
  createdAt: t.String(),
  updatedAt: t.String(),
});
export type ConfigFile = Static<typeof ConfigFileSchema>;

export const CreateConfigFileBodySchema = t.Object({
  path: t.String({ minLength: 1 }),
  content: t.String(),
  contentType: ConfigFileContentTypeSchema,
  scope: ConfigFileScopeSchema,
  workspaceId: t.Optional(t.String()),
});
export type CreateConfigFileBody = Static<typeof CreateConfigFileBodySchema>;

export const UpdateConfigFileBodySchema = t.Object({
  content: t.Optional(t.String()),
  contentType: t.Optional(ConfigFileContentTypeSchema),
});
export type UpdateConfigFileBody = Static<typeof UpdateConfigFileBodySchema>;

export const ConfigFileListQuerySchema = t.Object({
  scope: t.Optional(ConfigFileScopeSchema),
  workspaceId: t.Optional(t.String()),
});
export type ConfigFileListQuery = Static<typeof ConfigFileListQuerySchema>;

export const ConfigFileListResponseSchema = t.Array(ConfigFileSchema);
export type ConfigFileListResponse = Static<
  typeof ConfigFileListResponseSchema
>;

export const MergedConfigFileSchema = t.Object({
  path: t.String(),
  content: t.String(),
  contentType: ConfigFileContentTypeSchema,
});
export type MergedConfigFile = Static<typeof MergedConfigFileSchema>;

export const MergedConfigQuerySchema = t.Object({
  workspaceId: t.Optional(t.String()),
});
export type MergedConfigQuery = Static<typeof MergedConfigQuerySchema>;

export const MergedConfigResponseSchema = t.Array(MergedConfigFileSchema);
export type MergedConfigResponse = Static<typeof MergedConfigResponseSchema>;
