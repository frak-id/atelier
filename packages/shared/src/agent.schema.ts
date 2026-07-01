import { type Static, Type } from "@sinclair/typebox";

/**
 * Harness-neutral agent-session types exposed by the manager facade.
 *
 * The dashboard consumes ONLY these shapes (never a harness SDK). For opencode
 * the manager's OpencodeSessionSurface maps `opencode serve`'s REST responses
 * onto them; a future ACP-only harness would map its ACP session store onto the
 * same shapes (with the known gaps: no hierarchy, no separate questions).
 *
 * Field set is the minimum the dashboard actually reads (see recon), with a few
 * zero-cost passthrough fields kept optional. Session ids are normalized to
 * `sessionId` (serve uses `sessionID`).
 */

export const AgentSessionSchema = Type.Object({
  /** Sandbox that owns this session (injected by the manager). */
  sandboxId: Type.String(),
  id: Type.String(),
  /** Parent session id for hierarchy (opencode serve only; absent otherwise). */
  parentID: Type.Optional(Type.String()),
  title: Type.String(),
  directory: Type.String(),
  time: Type.Object({
    created: Type.Number(),
    updated: Type.Number(),
  }),
});
export type AgentSession = Static<typeof AgentSessionSchema>;

export const AgentSessionStatusSchema = Type.Union([
  Type.Object({ type: Type.Literal("idle") }),
  Type.Object({ type: Type.Literal("busy") }),
  Type.Object({
    type: Type.Literal("retry"),
    attempt: Type.Number(),
    message: Type.String(),
    next: Type.Number(),
  }),
]);
export type AgentSessionStatus = Static<typeof AgentSessionStatusSchema>;

export const AgentTodoSchema = Type.Object({
  content: Type.String(),
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("in_progress"),
    Type.Literal("completed"),
    Type.Literal("cancelled"),
  ]),
  priority: Type.Optional(Type.String()),
});
export type AgentTodo = Static<typeof AgentTodoSchema>;

export const AgentPermissionRequestSchema = Type.Object({
  id: Type.String(),
  sessionId: Type.String(),
  /** Human-readable label for what is being requested. */
  permission: Type.String(),
  patterns: Type.Optional(Type.Array(Type.String())),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  always: Type.Optional(Type.Array(Type.String())),
});
export type AgentPermissionRequest = Static<
  typeof AgentPermissionRequestSchema
>;

/** Reply to a permission request. `always` = allow this kind for the session. */
export const AgentPermissionReplySchema = Type.Union([
  Type.Literal("once"),
  Type.Literal("always"),
  Type.Literal("reject"),
]);
export type AgentPermissionReply = Static<typeof AgentPermissionReplySchema>;

export const AgentQuestionRequestSchema = Type.Object({
  id: Type.String(),
  sessionId: Type.String(),
  questions: Type.Array(
    Type.Object({
      question: Type.String(),
      header: Type.String(),
      options: Type.Array(
        Type.Object({
          label: Type.String(),
          description: Type.String(),
        }),
      ),
      multiple: Type.Optional(Type.Boolean()),
      custom: Type.Optional(Type.Boolean()),
    }),
  ),
});
export type AgentQuestionRequest = Static<typeof AgentQuestionRequestSchema>;

/**
 * A cache-invalidation signal fanned out over the facade SSE stream. The
 * dashboard invalidates the query for `(resource, sandboxId[, sessionId])`; it
 * never reads event payloads (except `sessionId` to scope todo invalidation),
 * so the manager collapses each harness's native event taxonomy onto these
 * coarse resource kinds.
 */
export const AgentEventSchema = Type.Object({
  sandboxId: Type.String(),
  resource: Type.Union([
    Type.Literal("sessions"),
    Type.Literal("sessionStatuses"),
    Type.Literal("permissions"),
    Type.Literal("questions"),
    Type.Literal("todos"),
  ]),
  sessionId: Type.Optional(Type.String()),
});
export type AgentEvent = Static<typeof AgentEventSchema>;
