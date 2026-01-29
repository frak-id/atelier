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

export const JobStatusSchema = t.Union([
  t.Literal("queued"),
  t.Literal("running"),
  t.Literal("completed"),
  t.Literal("failed"),
]);
export type JobStatus = Static<typeof JobStatusSchema>;

export const SpawnJobSchema = t.Object({
  id: t.String(),
  options: CreateSandboxBodySchema,
  status: JobStatusSchema,
  result: t.Optional(SandboxSchema),
  error: t.Optional(t.String()),
  queuedAt: t.String(),
  startedAt: t.Optional(t.String()),
  completedAt: t.Optional(t.String()),
});
export type SpawnJob = Static<typeof SpawnJobSchema>;

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

export const RegisterAppBodySchema = t.Object({
  port: t.Number({ minimum: 1, maximum: 65535 }),
  name: t.String({ minLength: 1, maxLength: 100 }),
});
export type RegisterAppBody = Static<typeof RegisterAppBodySchema>;

export const AppPortSchema = t.Object({
  port: t.Number(),
  name: t.String(),
  registeredAt: t.String(),
});
export type AppPort = Static<typeof AppPortSchema>;

export const AppPortListResponseSchema = t.Array(AppPortSchema);
export type AppPortListResponse = Static<typeof AppPortListResponseSchema>;

export const ServiceStatusSchema = t.Object({
  name: t.String(),
  running: t.Boolean(),
  pid: t.Optional(t.Number()),
});
export type ServiceStatus = Static<typeof ServiceStatusSchema>;

export const ServicesResponseSchema = t.Object({
  services: t.Array(ServiceStatusSchema),
});
export type ServicesResponse = Static<typeof ServicesResponseSchema>;

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
  services: t.Object({
    vscode: t.Boolean(),
    opencode: t.Boolean(),
    sshd: t.Boolean(),
    ttyd: t.Boolean(),
  }),
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

export const DevCommandListResponseSchema = t.Object({
  commands: t.Array(
    t.Object({
      name: t.String(),
      command: t.String(),
      port: t.Optional(t.Number()),
      workdir: t.Optional(t.String()),
      env: t.Optional(t.Record(t.String(), t.String())),
      isDefault: t.Optional(t.Boolean()),
      status: t.String(),
      pid: t.Optional(t.Number()),
      startedAt: t.Optional(t.String()),
      exitCode: t.Optional(t.Number()),
      devUrl: t.Optional(t.String()),
      defaultDevUrl: t.Optional(t.String()),
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
