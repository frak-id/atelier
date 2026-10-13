/**
 * Sandbox activity + idle auto-pause contract (docs/proposals/
 * sandbox-idle-autopause.md). The rules are operator config; this file is
 * only the wire shapes a client reads (`GET /v1/sandboxes/:id/activity`, the
 * `idle` decoration on list rows) and the annotations the server sets.
 */
import { type Static, Type } from "@sinclair/typebox";

/** When the sandbox may be idle-paused again: an ISO timestamp, or
 * {@link KEEP_AWAKE_FOREVER} when the operator allows open-ended ones. Set
 * through `PATCH /v1/sandboxes/:id` `keepAwakeUntil`. */
export const SANDBOX_KEEP_AWAKE_ANNOTATION = "atelier.dev/keep-awake-until";
export const KEEP_AWAKE_FOREVER = "forever";

/** ISO time the idle reaper paused the sandbox. Present only while the
 * sandbox stays paused (the reaper clears it once it runs again). */
export const SANDBOX_IDLE_PAUSED_ANNOTATION = "atelier.dev/idle-paused-at";

/**
 * The agent's network sensor when the guest kernel has no `inet_diag`
 * (Kata's stock kernel): interface counters. Bytes received and sent, minus
 * the agent's own control traffic, but not who opened a connection nor which
 * process moved them. Minutes then carry received bytes as `inboundBytes`
 * and sent as `outboundBytes`, and their sum counts for both directions: an
 * operator's `inbound`-only rule keeps such a sandbox awake longer, never
 * pauses it early.
 */
export const INTERFACE_NETWORK_SENSOR = "netdev";

export const ActivitySignalSchema = Type.Union([
  Type.Literal("ssh"),
  Type.Literal("console"),
  Type.Literal("api"),
  Type.Literal("lifecycle"),
  Type.Literal("agent"),
  Type.Literal("networkInbound"),
  Type.Literal("networkOutbound"),
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
    /** Bytes (both directions) on connections to a listening port here. */
    inboundBytes: Type.Number(),
    /** Bytes (both directions) on connections the sandbox opened. */
    outboundBytes: Type.Number(),
    fileWrites: Type.Number(),
    cpuMs: Type.Number(),
  },
  { additionalProperties: false },
);
export type ActivityMinute = Static<typeof ActivityMinuteSchema>;

/** Network bytes of one process over the agent's window (the last hour).
 * Stats only: the pause decision never looks at processes. */
export const ProcessTrafficSchema = Type.Object(
  {
    /** The supervised process name from the spec, else the process `comm`. */
    name: Type.String(),
    supervised: Type.Boolean(),
    inboundBytes: Type.Number(),
    outboundBytes: Type.Number(),
  },
  { additionalProperties: false },
);
export type ProcessTraffic = Static<typeof ProcessTrafficSchema>;

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
    /** The operator's bounds on `keepAwakeUntil`. */
    keepAwakeLimits: Type.Object(
      { maxHours: Type.Number(), allowForever: Type.Boolean() },
      { additionalProperties: false },
    ),
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
        /** Network sensor: `sock_diag+destroy` / `sock_diag` (per
         * connection, direction and process known), `netdev` (see
         * {@link INTERFACE_NETWORK_SENSOR}), or `unavailable`. */
        network: Type.Optional(Type.String()),
        files: Type.Optional(Type.String()),
        cpu: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    /** Per-minute measurements for the last hour, oldest first. Minutes with
     * nothing measured are omitted. */
    minutes: Type.Array(ActivityMinuteSchema),
    processes: Type.Array(ProcessTrafficSchema),
  },
  { additionalProperties: false, $id: "SandboxActivity" },
);
export type SandboxActivity = Static<typeof SandboxActivitySchema>;
