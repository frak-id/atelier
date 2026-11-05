/**
 * Constants the server must agree on with the in-pod agent (`apps/agent`).
 * Everything the agent bounds on its own side gets a server-side timeout here
 * that is the agent's value plus a margin, so the caller sees the agent's own
 * specific error ("pulled 1 of 3", "Command timed out") instead of the client
 * aborting first and reporting a generic `AgentUnavailableError`.
 *
 * `sandbox-boot.sh` waits on the same ceiling (its home-ready deadline is
 * `AGENT_BUILD_TIMEOUT_MS` + 30s, in seconds): change them together.
 */

/** WS attach bridge port (Rust: `attach::ATTACH_PORT`). */
export const AGENT_ATTACH_PORT = 9997;

/** Rust: `toolset::BUILD_TIMEOUT_MS`, the one deadline bounding a whole
 * build / capture / materialize call. */
const AGENT_BUILD_TIMEOUT_MS = 600_000;
/** Rust: `command::DEFAULT_EXEC_TIMEOUT_MS`, the limit each hook command (and
 * an `exec` that names no timeout) runs under. */
const AGENT_COMMAND_TIMEOUT_MS = 120_000;
/** Room for HTTP + serialization on top of the agent's own deadline. */
const MARGIN_MS = 30_000;

/** `POST /toolsets/build` and `/toolsets/capture`. */
export const BUILD_TIMEOUT_MS = AGENT_BUILD_TIMEOUT_MS + MARGIN_MS;
/** `POST /toolsets` (materialize). */
export const MATERIALIZE_TIMEOUT_MS = AGENT_BUILD_TIMEOUT_MS + MARGIN_MS;

/** `POST /hooks/{phase}`: the agent runs the phase's commands one after the
 * other, each under its own limit, so the phase may take all of them. */
export function hookPhaseTimeoutMs(commandCount: number): number {
  return Math.max(1, commandCount) * AGENT_COMMAND_TIMEOUT_MS + MARGIN_MS;
}

/** What `exec` allows a command when the caller names no timeout. Sent to the
 * agent explicitly so its limit and the client's abort agree. */
export const EXEC_DEFAULT_TIMEOUT_MS = 30_000;
/** Client-side slack on top of an exec's own timeout. */
export const EXEC_MARGIN_MS = 5_000;
