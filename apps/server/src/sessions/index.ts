/**
 * The sessions module's public interface. BOUNDARY RULE (design.md §3.1):
 * sessions/ talks to sandboxes only through the runtime API (attach + files),
 * never a private channel — and must not import control/.
 */

export { AcpSessionSurface } from "./acp/acp-session-surface.ts";
export { AgentDispatch } from "./acp/agent-dispatch.ts";
export { registerHarnessDispatch } from "./acp/harness-registry.ts";
export { SessionService } from "./session.service.ts";
export { AgentTaskService } from "./task.service.ts";
export { TerminalService } from "./terminal.service.ts";
