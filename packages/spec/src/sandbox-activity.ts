/**
 * Sandbox activity + idle auto-pause contract (docs/proposals/
 * sandbox-idle-autopause.md). The rules are operator config; this file is
 * only the wire shapes a client reads (`GET /v1/sandboxes/:id/activity`, the
 * `idle` decoration on list rows) and the annotations the server sets.
 */
import { type Static, Type } from "@sinclair/typebox";

/** When the sandbox may be idle-paused again: an ISO timestamp, set through
 * `PATCH /v1/sandboxes/:id` `keepAwakeUntil`. */
export const SANDBOX_KEEP_AWAKE_ANNOTATION = "atelier.dev/keep-awake-until";

/** ISO time the idle reaper paused the sandbox. Present only while the
 * sandbox stays paused (the reaper clears it once it runs again). */
export const SANDBOX_IDLE_PAUSED_ANNOTATION = "atelier.dev/idle-paused-at";

export const ActivitySignalSchema = Type.Union([
  Type.Literal("ssh"),
  Type.Literal("console"),
  Type.Literal("api"),
  Type.Literal("lifecycle"),
  Type.Literal("agent"),
  Type.Literal("network"),
  Type.Literal("files"),
  Type.Literal("cpu"),
]);
export type ActivitySignal = Static<typeof ActivitySignalSchema>;

export const IdleModeSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("observe"),
  Type.Literal("enforce"),
]);
export type IdleMode = Static<typeof IdleModeSchema>;

/**
 * - `off`: the rules are off.
 * - `not-running`: only a running sandbox has an idle clock.
 * - `active`: in use recently; `pausesAt` is in the future.
 * - `due`: idle past `pausesAt` with nothing blocking. Paused within a
 *   minute in `enforce` mode; only reported in `observe`.
 * - `blocked`: something in `blockers` prevents the pause.
 */
export const IdleStateSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("not-running"),
  Type.Literal("active"),
  Type.Literal("due"),
  Type.Literal("blocked"),
]);
export type IdleState = Static<typeof IdleStateSchema>;

/** Why a sandbox can't be idle-paused right now. */
export const IdleBlockerSchema = Type.Union([
  /** `keepAwakeUntil` is in the future. */
  Type.Literal("keep-awake"),
  /** A server-driven ACP turn is in flight. */
  Type.Literal("agent-turn"),
  /** The agent waits on a person to answer a permission request. */
  Type.Literal("permission-pending"),
  /** A job targets the sandbox (snapshot, toolset capture, fork). */
  Type.Literal("job"),
  /** A create/pause/resume/snapshot/destroy is in progress. */
  Type.Literal("lifecycle-op"),
  /** The rules need agent-side signals (network/files/CPU) but the sandbox's
   * agent doesn't report them (an image built before `/activity`). */
  Type.Literal("agent-unreported"),
]);
export type IdleBlocker = Static<typeof IdleBlockerSchema>;

/** The idle decoration on `GET /v1/sandboxes` rows. `mode` says whether
 * `pausesAt` is real (`enforce`) or only what would happen (`observe`). */
export const SandboxIdleSummarySchema = Type.Object(
  {
    mode: IdleModeSchema,
    state: IdleStateSchema,
    lastActiveAt: Type.Optional(Type.String()),
    pausesAt: Type.Optional(Type.String()),
  },
  { additionalProperties: false, $id: "SandboxIdleSummary" },
);
export type SandboxIdleSummary = Static<typeof SandboxIdleSummarySchema>;

/** One minute of agent-measured activity. */
export const ActivityMinuteSchema = Type.Object(
  {
    start: Type.String(),
    /** Interface bytes received, minus the agent's own control traffic. */
    receivedBytes: Type.Number(),
    /** Interface bytes sent, minus the agent's own control traffic. */
    sentBytes: Type.Number(),
    fileWrites: Type.Number(),
    cpuMs: Type.Number(),
  },
  { additionalProperties: false },
);
export type ActivityMinute = Static<typeof ActivityMinuteSchema>;

export const SandboxActivitySchema = Type.Object(
  {
    sandboxId: Type.String(),
    mode: IdleModeSchema,
    state: IdleStateSchema,
    idleMinutes: Type.Number(),
    lastActiveAt: Type.Optional(Type.String()),
    pausesAt: Type.Optional(Type.String()),
    blockers: Type.Array(IdleBlockerSchema),
    keepAwakeUntil: Type.Optional(Type.String()),
    /** The operator's bound on `keepAwakeUntil`, in hours ahead. */
    maxKeepAwakeHours: Type.Number(),
    idlePausedAt: Type.Optional(Type.String()),
    /** The signals the current rules count. */
    counted: Type.Array(ActivitySignalSchema),
    /** Last time each signal was seen (ISO), since the server started. */
    signals: Type.Partial(Type.Record(ActivitySignalSchema, Type.String())),
    thresholds: Type.Object(
      {
        networkMinBytesPerMinute: Type.Number(),
        cpuMinMillicores: Type.Number(),
      },
      { additionalProperties: false },
    ),
    agent: Type.Object(
      {
        /** The agent answers `GET /activity` (false: older agent image, or
         * not polled yet). */
        reporting: Type.Boolean(),
        polledAt: Type.Optional(Type.String()),
        /** Network sensor: `netdev` (interface counters) or
         * `unavailable`. */
        network: Type.Optional(Type.String()),
        files: Type.Optional(Type.String()),
        cpu: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    /** Per-minute measurements for the last hour, oldest first. Minutes with
     * nothing measured are omitted. */
    minutes: Type.Array(ActivityMinuteSchema),
  },
  { additionalProperties: false, $id: "SandboxActivity" },
);
export type SandboxActivity = Static<typeof SandboxActivitySchema>;
