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
 * `pi` itself may live in either of two places: pi's managed install
 * (`curl pi.dev/install.sh | sh`, also what `pi update` migrates to), whose
 * launcher is `~/.pi/agent/bin/pi`, or an npm global install under `~/.local`
 * (`~/.local/bin/pi`, what toolbox recipes install with `pi-acp`). `pi-acp`
 * spawns a bare `pi`, so both dirs go on the acp process's PATH, managed
 * first. `~/.local/bin` stays either way: `pi-acp` itself lives there.
 *
 * The supervisor runs every process command under `bash -l -c`, and Debian's
 * `/etc/profile` RESETS `PATH` in a login shell, so a `PATH` in the process
 * `env` never reaches the command (it was silently dropped, which is how a
 * managed-only pi install failed `session/new` with "executable not found").
 * The PATH is therefore prepended inside the command itself, after the
 * profile ran. pi's live ACP session surface IS wired into the server session
 * hub (a generic ACP-over-attach surface registered for `pi`, same as
 * opencode).
 */
import type { HarnessComposer } from "../harness.ts";
import type { SpecFragment } from "../spec-merge.ts";

const HOME = "/home/dev";
const LOCAL_BIN = `${HOME}/.local/bin`;
/** pi's managed-install launcher dir (`~/.pi/agent/bin/pi`). */
const PI_MANAGED_BIN = `${HOME}/.pi/agent/bin`;

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
        // pi's bin dirs are prepended HERE, not via `env.PATH`: the command
        // runs in a login shell whose /etc/profile resets PATH (see the file
        // header). Managed install first so it wins over a stale npm one;
        // absent dirs are harmless. `exec` keeps pi-acp as the supervised pid.
        command: `PATH="${PI_MANAGED_BIN}:${LOCAL_BIN}:$PATH" exec ${LOCAL_BIN}/pi-acp`,
        cwd: HOME,
        // Run as `dev` so pi writes its data/config under ${HOME}, not root.
        user: "dev",
        // HOME so pi resolves ~/.pi, ~/.config/pi-cliproxyapi, etc.
        env: { HOME },
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
