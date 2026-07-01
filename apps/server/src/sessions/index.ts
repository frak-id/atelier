/**
 * The sessions module's public interface. BOUNDARY RULE (atelier-v2 §3.1):
 * sessions/ talks to sandboxes only through the runtime API (attach + files),
 * never a private channel — and must not import control/.
 */

export { type AcpTransport, connectAcpWebSocket } from "./acp/acp-stream.ts";
export {
  AgentDispatch,
  type AgentSession,
  type AgentSessionCallbacks,
  type OpenAgentSessionInput,
} from "./acp/agent-dispatch.ts";
export {
  type AgentModelSelection,
  DEFAULT_HARNESS_ID,
  type HarnessDispatchAdapter,
  listHarnessDispatchIds,
  registerHarnessDispatch,
  resolveHarnessDispatch,
  type SessionConfigAssignment,
} from "./acp/harness-registry.ts";
export {
  SessionService,
  type SessionSurfaceResolver,
} from "./session.service.ts";
export type {
  AgentConnection,
  CreateSessionResult,
  HarnessSessionSurface,
  InterventionResult,
} from "./session-surface.ts";
export { TerminalService } from "./terminal.service.ts";
