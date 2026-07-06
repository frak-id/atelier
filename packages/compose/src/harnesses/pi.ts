/**
 * The pi harness composer — the spec-fragment analog of `opencode.ts` for the
 * pi coding agent (`pi-acp`). Self-contained: no runtime imports. Composing a
 * harness only declares *what runs* (the primary `acp` process + display
 * annotation); the pi binary itself is delivered by a toolbox/toolset that
 * puts `pi-acp` on `~/.local/bin` (the dev-base PATH shim), exactly like
 * opencode.
 *
 * Note: pi's live ACP session surface is not wired into the server's session
 * hub yet (only opencode is), so a pi sandbox boots correctly but its sessions
 * aren't drivable from the console today. Composition is independent of that.
 */
import type { HarnessComposer } from "../harness.ts";
import type { SpecFragment } from "../spec-merge.ts";

const HOME = "/home/dev";

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
        // Bare command: the pi toolbox materializes `pi-acp` onto PATH via the
        // dev-base `~/.local/bin` shim.
        command: "pi-acp",
        cwd: HOME,
        // Run as `dev` so pi writes its data/config under ${HOME}, not root.
        user: "dev",
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
