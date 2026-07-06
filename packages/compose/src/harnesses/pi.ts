/**
 * The pi harness composer — the spec-fragment analog of `opencode.ts` for the
 * pi coding agent (`pi-acp`). Self-contained: no runtime imports. Composing a
 * harness only declares *what runs* (the primary `acp` process + display
 * annotation); the pi binary itself is delivered by a toolbox/toolset that
 * installs `pi`/`pi-acp` under `~/.local` (e.g. `npm install -g --prefix
 * ~/.local @earendil-works/pi-coding-agent pi-acp`), exactly like opencode.
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
 * primary — the sandbox's health gate) plus its display annotations.
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
    // TODO(pi-web-ui): mirror opencode's lazy `serve` + forward-auth port
    // (design ui-evolution.md §3.3) once pi ships a verified in-sandbox web
    // server command. Do NOT point at the external pi-web.dev (rejected: its
    // origin can't carry the *.baseDomain oauth2-proxy cookie, breaking
    // forward-auth for both the redirect and any cross-origin XHR/CORS).
  };
}

/** The registrable composer — registered by the server/CLI bootstrap. */
export const piHarness: HarnessComposer = {
  id: "pi",
  compose: (opts) => composePi(opts as ComposePiOptions | undefined),
};
