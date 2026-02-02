import type { Static } from "elysia";
import { t } from "elysia";

export const SystemStatsSchema = t.Object({
  cpuUsage: t.Number(),
  memoryUsed: t.Number(),
  memoryTotal: t.Number(),
  memoryPercent: t.Number(),
  diskUsed: t.Number(),
  diskTotal: t.Number(),
  diskPercent: t.Number(),
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
    firecracker: HealthCheckStatusSchema,
    caddy: HealthCheckStatusSchema,
    network: HealthCheckStatusSchema,
    storage: HealthCheckStatusSchema,
    lvm: t.Union([t.Literal("ok"), t.Literal("unavailable")]),
  }),
});
export type HealthStatus = Static<typeof HealthStatusSchema>;

export const CleanupResultSchema = t.Object({
  socketsRemoved: t.Number(),
  overlaysRemoved: t.Number(),
  tapDevicesRemoved: t.Number(),
  lvmVolumesRemoved: t.Number(),
  logsRemoved: t.Number(),
  caddyRoutesRemoved: t.Number(),
  sshRoutesRemoved: t.Number(),
  spaceFreed: t.Number(),
});
export type CleanupResult = Static<typeof CleanupResultSchema>;

export const StoragePoolStatsSchema = t.Object({
  exists: t.Boolean(),
  dataPercent: t.Number(),
  metadataPercent: t.Number(),
  totalSize: t.String(),
  usedSize: t.String(),
  volumeCount: t.Number(),
});
export type StoragePoolStats = Static<typeof StoragePoolStatsSchema>;

export const StorageStatusSchema = t.Object({
  available: t.Boolean(),
  hasDefaultImage: t.Boolean(),
  pool: StoragePoolStatsSchema,
});
export type StorageStatus = Static<typeof StorageStatusSchema>;

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
