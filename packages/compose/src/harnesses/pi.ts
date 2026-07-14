/**
 * The pi harness composer — the spec-fragment analog of `opencode.ts` for the
 * pi coding agent (`pi-acp`). Self-contained: no runtime imports. The harness
 * declares ONLY how the server talks to pi: the primary `acp` process
 * (stdio-bridged) plus display annotations. Everything else pi needs — the
 * `pi-acp` binary and the pi-web UI (session daemon + web server, its port and
 * processes) — is delivered by a toolbox/toolset that installs `pi`/`pi-acp`
 * (and, for the web UI, `@jmfederico/pi-web`) under `~/.local` and contributes
 * the pi-web processes/ports itself. The harness never assumes those binaries
 * exist, so it declares no pi-web process or port.
 *
 * The `acp` process is spawned directly by the supervisor (no login shell), so
 * the `~/.local/bin` PATH shim from `/etc/profile.d` is NOT sourced — the
 * command must be the ABSOLUTE binary path with an explicit `PATH`/`HOME` env
 * (verified against staging: bare `pi-acp` does not resolve). pi's live ACP
 * session surface IS wired into the server session hub (a generic
 * ACP-over-attach surface registered for `pi`, same as opencode).
 */
import type { HarnessComposer } from "../harness.ts";
import type { SpecFragment } from "../spec-merge.ts";

const HOME = "/home/dev";
const LOCAL_BIN = `${HOME}/.local/bin`;

export interface ComposePiOptions {
  /** MCP server names to record in the `atelier.dev/mcp` annotation. */
  mcp?: string[];
}

/**
 * Compose pi's spec fragment: the `acp` process (`pi-acp`, stdio-bridged,
 * primary — the sandbox's health gate) plus its display annotations. The
 * pi-web UI is NOT here — a toolbox owns that surface.
 */
export function composePi(opts: ComposePiOptions = {}): SpecFragment {
  return {
    processes: [
      {
        name: "acp",
        // Absolute path, not bare `pi-acp`: the supervisor spawns the process
        // directly (no login shell), so the `~/.local/bin` PATH shim from
        // /etc/profile.d is not sourced. Verified on staging — the bare
        // command does not resolve; the absolute binary + explicit env do.
        command: `${LOCAL_BIN}/pi-acp`,
        cwd: HOME,
        // Run as `dev` so pi writes its data/config under ${HOME}, not root.
        user: "dev",
        // Explicit PATH/HOME: the process runs without a login shell, so
        // `pi-acp` needs `~/.local/bin` on PATH to exec its own tools, and
        // HOME so pi resolves ~/.pi, ~/.config/pi-cliproxyapi, etc.
        env: {
          PATH: `${LOCAL_BIN}:/usr/local/bin:/usr/bin:/bin`,
          HOME,
        },
        stdio: "bridge",
        primary: true,
      },
    ],
    annotations: {
      "atelier.dev/harness": "pi",
      ...(opts.mcp && opts.mcp.length > 0
        ? { "atelier.dev/mcp": opts.mcp.join(",") }
        : {}),
    },
  };
}

/** The registrable composer — registered by the server/CLI bootstrap. */
export const piHarness: HarnessComposer = {
  id: "pi",
  compose: (opts) => composePi(opts as ComposePiOptions | undefined),
};
