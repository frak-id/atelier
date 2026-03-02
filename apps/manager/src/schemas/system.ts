import type { Static } from "elysia";
import { t } from "elysia";

export const SystemStatsSchema = t.Object({
  activeSandboxes: t.Number(),
  maxSandboxes: t.Number(),
  uptime: t.Number(),
});
export type SystemStats = Static<typeof SystemStatsSchema>;

export const HealthCheckStatusSchema = t.Union([
  t.Literal("ok"),
  t.Literal("error"),
]);

export const HealthStatusSchema = t.Object({
  status: t.Union([t.Literal("ok"), t.Literal("degraded"), t.Literal("error")]),
  uptime: t.Number(),
  timestamp: t.Number(),
  checks: t.Object({
    kubernetes: HealthCheckStatusSchema,
    kata: HealthCheckStatusSchema,
    registry: HealthCheckStatusSchema,
  }),
});
export type HealthStatus = Static<typeof HealthStatusSchema>;

export const LiveStatusSchema = t.Object({
  status: t.Literal("ok"),
});
export type LiveStatus = Static<typeof LiveStatusSchema>;

export const ReadyStatusSchema = t.Union([
  t.Object({ status: t.Literal("ready") }),
  t.Object({ status: t.Literal("not ready"), reason: t.String() }),
]);
export type ReadyStatus = Static<typeof ReadyStatusSchema>;

export const CronJobInfoSchema = t.Object({
  name: t.String(),
  pattern: t.String(),
  running: t.Boolean(),
  lastRun: t.Nullable(t.String()),
  nextRun: t.Nullable(t.String()),
});
export type CronJobInfo = Static<typeof CronJobInfoSchema>;

export const SystemSandboxStatusSchema = t.Object({
  status: t.Union([
    t.Literal("off"),
    t.Literal("booting"),
    t.Literal("running"),
    t.Literal("idle"),
  ]),
  sandboxId: t.Nullable(t.String()),
  activeCount: t.Number(),
  uptimeMs: t.Nullable(t.Number()),
  opencodeUrl: t.Nullable(t.String()),
  prebuild: t.Object({
    exists: t.Boolean(),
    building: t.Boolean(),
    builtAt: t.Nullable(t.String()),
  }),
});
export type SystemSandboxStatusResponse = Static<
  typeof SystemSandboxStatusSchema
>;
