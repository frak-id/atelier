import { OpencodeSessionSurface } from "./opencode-session-surface.ts";
import type {
  AgentConnection,
  HarnessSessionSurface,
} from "./session-surface.ts";

/**
 * Resolve the dashboard session surface for a harness. Only opencode exists
 * today (served via `opencode serve` REST); ACP-only harnesses would register a
 * flat ACP-backed surface here.
 */
export function resolveSessionSurface(
  harnessId: string,
  conn: AgentConnection,
): HarnessSessionSurface {
  switch (harnessId) {
    case "opencode":
      return new OpencodeSessionSurface(conn);
    default:
      throw new Error(`No session surface for harness "${harnessId}"`);
  }
}
