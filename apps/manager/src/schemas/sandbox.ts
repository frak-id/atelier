import type { Static } from "elysia";
import { t } from "elysia";

export const SandboxStatusSchema = t.Union([
  t.Literal("creating"),
  t.Literal("running"),
  t.Literal("stopped"),
  t.Literal("error"),
]);
export type SandboxStatus = Static<typeof SandboxStatusSchema>;

export const SandboxUrlsSchema = t.Object({
  vscode: t.String(),
  opencode: t.String(),
  terminal: t.String(),
  ssh: t.String(),
  browser: t.Optional(t.String()),
});
export type SandboxUrls = Static<typeof SandboxUrlsSchema>;

export const SandboxRuntimeSchema = t.Object({
  ipAddress: t.String(),
  macAddress: t.String(),
  urls: SandboxUrlsSchema,
  vcpus: t.Number(),
  memoryMb: t.Number(),
  pid: t.Optional(t.Number()),
  error: t.Optional(t.String()),
});
export type SandboxRuntime = Static<typeof SandboxRuntimeSchema>;

export const SandboxSchema = t.Object({
  id: t.String(),
  workspaceId: t.Optional(t.String()),
  status: SandboxStatusSchema,
  runtime: SandboxRuntimeSchema,
  createdAt: t.String(),
  updatedAt: t.String(),
});
export type Sandbox = Static<typeof SandboxSchema>;

export const CreateSandboxBodySchema = t.Object({
  workspaceId: t.Optional(t.String()),
  baseImage: t.Optional(t.String()),
  vcpus: t.Optional(t.Number({ minimum: 1, maximum: 8 })),
  memoryMb: t.Optional(t.Number({ minimum: 512, maximum: 16384 })),
});
export type CreateSandboxBody = Static<typeof CreateSandboxBodySchema>;

export const SandboxListQuerySchema = t.Object({
  status: t.Optional(SandboxStatusSchema),
  workspaceId: t.Optional(t.String()),
});
export type SandboxListQuery = Static<typeof SandboxListQuerySchema>;

export const SandboxListResponseSchema = t.Array(SandboxSchema);
export type SandboxListResponse = Static<typeof SandboxListResponseSchema>;

export const ExecBodySchema = t.Object({
  command: t.String({ minLength: 1 }),
  timeout: t.Optional(t.Number({ minimum: 1000, maximum: 300000 })),
});
export type ExecBody = Static<typeof ExecBodySchema>;

export const ExecResponseSchema = t.Object({
  exitCode: t.Number(),
  stdout: t.String(),
  stderr: t.String(),
});
export type ExecResponse = Static<typeof ExecResponseSchema>;

export const ServiceStatusSchema = t.Object({
  name: t.String(),
  status: t.Union([
    t.Literal("running"),
    t.Literal("stopped"),
    t.Literal("error"),
  ]),
  running: t.Boolean(),
  pid: t.Optional(t.Number()),
  port: t.Optional(t.Number()),
  startedAt: t.Optional(t.String()),
  exitCode: t.Optional(t.Number()),
  logFile: t.Optional(t.String()),
});
export type ServiceStatus = Static<typeof ServiceStatusSchema>;

export const ServicesResponseSchema = t.Object({
  services: t.Array(ServiceStatusSchema),
});
export type ServicesResponse = Static<typeof ServicesResponseSchema>;

export const ServiceNameParamsSchema = t.Object({
  id: t.String(),
  name: t.String(),
});
export type ServiceNameParams = Static<typeof ServiceNameParamsSchema>;

export const ServiceActionResponseSchema = t.Object({
  status: t.String(),
  name: t.String(),
  pid: t.Optional(t.Number()),
  port: t.Optional(t.Number()),
  message: t.Optional(t.String()),
  logFile: t.Optional(t.String()),
  startedAt: t.Optional(t.String()),
});
export type ServiceActionResponse = Static<typeof ServiceActionResponseSchema>;

export const LogsParamsSchema = t.Object({
  id: t.String(),
  service: t.String(),
});
export type LogsParams = Static<typeof LogsParamsSchema>;

export const LogsQuerySchema = t.Object({
  lines: t.Optional(t.String()),
});
export type LogsQuery = Static<typeof LogsQuerySchema>;

export const LogsResponseSchema = t.Object({
  logs: t.String(),
});
export type LogsResponse = Static<typeof LogsResponseSchema>;

export const AgentHealthSchema = t.Object({
  status: t.String(),
  sandboxId: t.Optional(t.String()),
  uptime: t.Number(),
});
export type AgentHealth = Static<typeof AgentHealthSchema>;

export const AgentMetricsSchema = t.Object({
  cpu: t.Number(),
  memory: t.Object({
    total: t.Number(),
    used: t.Number(),
    free: t.Number(),
  }),
  disk: t.Object({
    total: t.Number(),
    used: t.Number(),
    free: t.Number(),
  }),
  timestamp: t.String(),
});
export type AgentMetrics = Static<typeof AgentMetricsSchema>;

export const RepoGitStatusSchema = t.Object({
  path: t.String(),
  branch: t.Union([t.String(), t.Null()]),
  dirty: t.Boolean(),
  ahead: t.Number(),
  behind: t.Number(),
  lastCommit: t.Union([t.String(), t.Null()]),
  error: t.Optional(t.String()),
});
export type RepoGitStatus = Static<typeof RepoGitStatusSchema>;

export const GitStatusResponseSchema = t.Object({
  repos: t.Array(RepoGitStatusSchema),
});
export type GitStatusResponse = Static<typeof GitStatusResponseSchema>;

export const GitDiffResponseSchema = t.Object({
  repos: t.Array(
    t.Object({
      path: t.String(),
      files: t.Array(
        t.Object({
          path: t.String(),
          added: t.Number(),
          removed: t.Number(),
        }),
      ),
      totalAdded: t.Number(),
      totalRemoved: t.Number(),
      error: t.Optional(t.String()),
    }),
  ),
});
export type GitDiffResponse = Static<typeof GitDiffResponseSchema>;

export const GitCommitBodySchema = t.Object({
  repoPath: t.String({ minLength: 1 }),
  message: t.String({ minLength: 1 }),
});
export type GitCommitBody = Static<typeof GitCommitBodySchema>;

export const GitCommitResponseSchema = t.Object({
  path: t.String(),
  success: t.Boolean(),
  hash: t.Optional(t.String()),
  error: t.Optional(t.String()),
});
export type GitCommitResponse = Static<typeof GitCommitResponseSchema>;

export const GitPushBodySchema = t.Object({
  repoPath: t.String({ minLength: 1 }),
});
export type GitPushBody = Static<typeof GitPushBodySchema>;

export const GitPushResponseSchema = t.Object({
  path: t.String(),
  success: t.Boolean(),
  error: t.Optional(t.String()),
});
export type GitPushResponse = Static<typeof GitPushResponseSchema>;

export const ResizeStorageBodySchema = t.Object({
  sizeGb: t.Number({ minimum: 1, maximum: 100 }),
});
export type ResizeStorageBody = Static<typeof ResizeStorageBodySchema>;

export const ResizeStorageResponseSchema = t.Object({
  success: t.Boolean(),
  previousSize: t.Number(),
  newSize: t.Number(),
  disk: t.Optional(
    t.Object({
      total: t.Number(),
      used: t.Number(),
      free: t.Number(),
    }),
  ),
  error: t.Optional(t.String()),
});
export type ResizeStorageResponse = Static<typeof ResizeStorageResponseSchema>;

export const PromoteToPrebuildResponseSchema = t.Object({
  success: t.Boolean(),
  message: t.String(),
  workspaceId: t.String(),
});
export type PromoteToPrebuildResponse = Static<
  typeof PromoteToPrebuildResponseSchema
>;

export const ExtraDevUrlSchema = t.Object({
  alias: t.String(),
  port: t.Number(),
  url: t.String(),
});
export type ExtraDevUrl = Static<typeof ExtraDevUrlSchema>;

export const DevCommandListResponseSchema = t.Object({
  commands: t.Array(
    t.Object({
      name: t.String(),
      command: t.String(),
      port: t.Optional(t.Number()),
      extraPorts: t.Optional(
        t.Array(t.Object({ port: t.Number(), alias: t.String() })),
      ),
      workdir: t.Optional(t.String()),
      env: t.Optional(t.Record(t.String(), t.String())),
      isDefault: t.Optional(t.Boolean()),
      status: t.String(),
      pid: t.Optional(t.Number()),
      startedAt: t.Optional(t.String()),
      exitCode: t.Optional(t.Number()),
      devUrl: t.Optional(t.String()),
      defaultDevUrl: t.Optional(t.String()),
      extraDevUrls: t.Optional(t.Array(ExtraDevUrlSchema)),
    }),
  ),
});
export type DevCommandListResponse = Static<
  typeof DevCommandListResponseSchema
>;

export const DevCommandStartResponseSchema = t.Object({
  status: t.String(),
  pid: t.Optional(t.Number()),
  name: t.String(),
  port: t.Optional(t.Number()),
  logFile: t.Optional(t.String()),
  startedAt: t.Optional(t.String()),
  devUrl: t.Optional(t.String()),
  defaultDevUrl: t.Optional(t.String()),
  extraDevUrls: t.Optional(t.Array(ExtraDevUrlSchema)),
});
export type DevCommandStartResponse = Static<
  typeof DevCommandStartResponseSchema
>;

export const DevCommandStopResponseSchema = t.Object({
  status: t.String(),
  name: t.String(),
  pid: t.Optional(t.Number()),
  message: t.Optional(t.String()),
  exitCode: t.Optional(t.Number()),
});
export type DevCommandStopResponse = Static<
  typeof DevCommandStopResponseSchema
>;

export const DevCommandLogsResponseSchema = t.Object({
  name: t.String(),
  content: t.String(),
  nextOffset: t.Number(),
});
export type DevCommandLogsResponse = Static<
  typeof DevCommandLogsResponseSchema
>;

export const DevCommandNameParamsSchema = t.Object({
  id: t.String(),
  name: t.String(),
});
export type DevCommandNameParams = Static<typeof DevCommandNameParamsSchema>;

export const DevCommandLogsQuerySchema = t.Object({
  offset: t.Optional(t.String()),
  limit: t.Optional(t.String()),
});
export type DevCommandLogsQuery = Static<typeof DevCommandLogsQuerySchema>;

export const BrowserStatusSchema = t.Union([
  t.Literal("off"),
  t.Literal("starting"),
  t.Literal("running"),
]);
export type BrowserStatus = Static<typeof BrowserStatusSchema>;

export const BrowserStatusResponseSchema = t.Object({
  status: BrowserStatusSchema,
  url: t.Optional(t.String()),
});
export type BrowserStatusResponse = Static<typeof BrowserStatusResponseSchema>;

export const BrowserStartResponseSchema = t.Object({
  status: BrowserStatusSchema,
  url: t.Optional(t.String()),
});
export type BrowserStartResponse = Static<typeof BrowserStartResponseSchema>;

export const BrowserStopResponseSchema = t.Object({
  status: BrowserStatusSchema,
});
export type BrowserStopResponse = Static<typeof BrowserStopResponseSchema>;
