import type { Static } from "elysia";
import { t } from "elysia";
import { SessionTemplatesSchema } from "./session-template.ts";

export const PrebuildStatusSchema = t.Union([
  t.Literal("none"),
  t.Literal("building"),
  t.Literal("ready"),
  t.Literal("failed"),
]);
export type PrebuildStatus = Static<typeof PrebuildStatusSchema>;

export const RepoConfigUrlSchema = t.Object({
  url: t.String(),
  branch: t.String(),
  clonePath: t.String(),
});

export const RepoConfigSourceSchema = t.Object({
  sourceId: t.String(),
  repo: t.String(),
  branch: t.String(),
  clonePath: t.String(),
});

export const RepoConfigSchema = t.Union([
  RepoConfigUrlSchema,
  RepoConfigSourceSchema,
]);
export type RepoConfig = Static<typeof RepoConfigSchema>;

export const PrebuildInfoSchema = t.Object({
  status: PrebuildStatusSchema,
  latestId: t.Optional(t.String()),
  builtAt: t.Optional(t.String()),
  // Key = clonePath (unique per repo), Value = commit hash at build time
  commitHashes: t.Optional(t.Record(t.String(), t.String())),
  lastCheckedAt: t.Optional(t.String()),
  stale: t.Optional(t.Boolean()),
});

export const FileSecretSchema = t.Object({
  name: t.String({ minLength: 1 }),
  path: t.String({ minLength: 1 }),
  content: t.String(),
  mode: t.Optional(t.String()),
});
export type FileSecret = Static<typeof FileSecretSchema>;

// Forbidden ports for dev commands (reserved for system services)
import { config } from "../shared/lib/config.ts";
export const FORBIDDEN_DEV_PORTS = [
  config.raw.services.vscode.port,
  config.raw.services.agent.port,
  22,
  config.raw.services.terminal.port,
  config.port,
] as const;

export const DevCommandSchema = t.Object({
  name: t.String({ pattern: "^[a-z0-9-]{1,20}$" }),
  command: t.String({ minLength: 1 }),
  port: t.Optional(t.Number({ minimum: 1024, maximum: 65535 })),
  workdir: t.Optional(t.String()),
  env: t.Optional(t.Record(t.String(), t.String())),
  isDefault: t.Optional(t.Boolean()),
});
export type DevCommand = Static<typeof DevCommandSchema>;

export const WorkspaceConfigSchema = t.Object({
  baseImage: t.String({ default: "dev-base" }),
  vcpus: t.Number({ minimum: 1, maximum: 8, default: 2 }),
  memoryMb: t.Number({ minimum: 512, maximum: 16384, default: 2048 }),
  initCommands: t.Array(t.String(), { default: [] }),
  secrets: t.Record(t.String(), t.String(), { default: {} }),
  fileSecrets: t.Optional(t.Array(FileSecretSchema, { default: [] })),
  repos: t.Array(RepoConfigSchema, { default: [] }),
  exposedPorts: t.Array(t.Number(), { default: [] }),
  prebuild: t.Optional(PrebuildInfoSchema),
  sessionTemplates: t.Optional(SessionTemplatesSchema),
  devCommands: t.Optional(t.Array(DevCommandSchema, { default: [] })),
});
export type WorkspaceConfig = Static<typeof WorkspaceConfigSchema>;

export const WorkspaceSchema = t.Object({
  id: t.String(),
  name: t.String(),
  config: WorkspaceConfigSchema,
  createdAt: t.String(),
  updatedAt: t.String(),
});
export type Workspace = Static<typeof WorkspaceSchema>;

export const CreateWorkspaceBodySchema = t.Object({
  name: t.String({ minLength: 1, maxLength: 100 }),
  config: t.Optional(t.Partial(WorkspaceConfigSchema)),
});
export type CreateWorkspaceBody = Static<typeof CreateWorkspaceBodySchema>;

export const UpdateWorkspaceBodySchema = t.Object({
  name: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
  config: t.Optional(t.Partial(WorkspaceConfigSchema)),
});
export type UpdateWorkspaceBody = Static<typeof UpdateWorkspaceBodySchema>;

export const WorkspaceListResponseSchema = t.Array(WorkspaceSchema);
export type WorkspaceListResponse = Static<typeof WorkspaceListResponseSchema>;

export const PrebuildTriggerResponseSchema = t.Object({
  message: t.String(),
  workspaceId: t.String(),
  status: t.String(),
});
export type PrebuildTriggerResponse = Static<
  typeof PrebuildTriggerResponseSchema
>;

export const DEFAULT_WORKSPACE_CONFIG: WorkspaceConfig = {
  baseImage: "dev-base",
  vcpus: 2,
  memoryMb: 2048,
  initCommands: [],
  secrets: {},
  fileSecrets: [],
  repos: [],
  exposedPorts: [],
};
