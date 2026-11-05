import { type Static, Type } from "@sinclair/typebox";

/**
 * Harness-neutral agent-session types exposed by the server's session API.
 *
 * The dashboard consumes ONLY these shapes (never a harness SDK); the server
 * maps the ACP session store of every harness onto them (ACP has no session
 * hierarchy, so `parentID` is always absent).
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
    Type.Literal("todos"),
  ]),
  sessionId: Type.Optional(Type.String()),
});
export type AgentEvent = Static<typeof AgentEventSchema>;
