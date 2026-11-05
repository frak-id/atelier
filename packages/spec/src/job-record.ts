import { type Static, Type } from "@sinclair/typebox";

/**
 * The durable long-running operations tracked by the server's `JobService`.
 * Global, no identity scope. The `sandbox-*` kinds are lifecycle ops tracked
 * for feed visibility (they bypass the concurrency pool); the rest are pooled
 * throwaway-pod builds. `sandbox-setup` is the work a spawn leaves running in
 * the live sandbox once it is up (a branch switch's build steps).
 */
export const JobKindSchema = Type.Union([
  Type.Literal("prebuild"),
  Type.Literal("toolset-build"),
  Type.Literal("toolset-capture"),
  Type.Literal("toolbox-refresh"),
  Type.Literal("image-build"),
  Type.Literal("sandbox-create"),
  Type.Literal("sandbox-pause"),
  Type.Literal("sandbox-resume"),
  Type.Literal("sandbox-snapshot"),
  Type.Literal("sandbox-destroy"),
  Type.Literal("sandbox-setup"),
]);
export type JobKind = Static<typeof JobKindSchema>;

/** `queued` = waiting for a concurrency slot (pooled jobs only). */
export const JobStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("canceled"),
]);
export type JobStatus = Static<typeof JobStatusSchema>;

export const JobRecordSchema = Type.Object({
  id: Type.String(),
  kind: JobKindSchema,
  status: JobStatusSchema,
  /** Human-facing label for the queue UI (prebuild/toolset name). */
  target: Type.Optional(Type.String()),
  /** Opaque display context (repo, slug, …). */
  metadata: Type.Optional(Type.Record(Type.String(), Type.String())),
  /** The operation's success payload (e.g. `{ ref }`), once `succeeded`. */
  result: Type.Optional(Type.Unknown()),
  error: Type.Optional(Type.String()),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  finishedAt: Type.Optional(Type.String()),
});
export type JobRecord = Static<typeof JobRecordSchema>;
