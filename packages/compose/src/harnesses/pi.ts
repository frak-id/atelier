/**
 * The pi harness composer — the spec-fragment analog of `opencode.ts` for the
 * pi coding agent (`pi-acp`). Self-contained: no runtime imports. Composing a
 * harness only declares *what runs* (the primary `acp` process, the lazy PI
 * WEB session daemon + web server, and display annotations); the binaries
 * themselves are delivered by a toolbox/toolset that installs `pi`/`pi-acp`
 * (and, for the web UI, `@jmfederico/pi-web`) under `~/.local` (e.g. `npm
 * install -g --prefix ~/.local @earendil-works/pi-coding-agent pi-acp
 * @jmfederico/pi-web`), exactly like opencode.
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
const PI_WEB_PORT = 8504;

export interface ComposePiOptions {
  /** MCP server names to record in the `atelier.dev/mcp` annotation. */
  mcp?: string[];
  /**
   * Value for PI WEB's `PI_WEB_ALLOWED_HOSTS` host-check (the sandbox is
   * served at `pi-{id}.{baseDomain}`, which pi-web-server would otherwise
   * reject). The control seam passes the base domain; omitted → the flag is
   * left off (pi-web's default). Never affects auth — the ingress forward-auth
   * gates the browser, same as opencode's `serve`.
   */
  webUiAllowedHosts?: string;
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
      // PI WEB (`@jmfederico/pi-web`, the self-hostable pi-web.dev) — the pi
      // analog of opencode's `serve` (design ui-evolution.md §3.3). Two
      // processes, mirroring the `browser` preset's kasmvnc/openbox/chromium
      // shape: a persistent session daemon plus the web/API server that holds
      // the public port and depends on it via `after`. Both lazy, so a plain
      // pi sandbox runs only `acp` until someone opens the web UI. The
      // binaries come from the pi toolbox (`npm i -g --prefix ~/.local
      // @jmfederico/pi-web`), like `pi-acp` — so absolute paths + explicit
      // PATH/HOME (the supervisor spawns without a login shell).
      {
        name: "pi-web-sessiond",
        command: `${LOCAL_BIN}/pi-web-sessiond`,
        cwd: HOME,
        user: "dev",
        env: {
          PATH: `${LOCAL_BIN}:/usr/local/bin:/usr/bin:/bin`,
          HOME,
        },
        lazy: true,
      },
      {
        // Named to match the `pi` port below — the console resolves "which URL
        // is the harness UI" by that convention. Auth-less by design (no
        // token): the operator forward-auth ingress is the trusted reverse
        // proxy pi-web mandates for a non-loopback bind.
        name: "pi",
        command: `${LOCAL_BIN}/pi-web-server`,
        cwd: HOME,
        user: "dev",
        after: ["pi-web-sessiond"],
        readiness: { port: PI_WEB_PORT },
        lazy: true,
        env: {
          PATH: `${LOCAL_BIN}:/usr/local/bin:/usr/bin:/bin`,
          HOME,
          // Bind all interfaces so the ingress can reach it (loopback default
          // is unreachable from outside the pod); forward-auth guards it.
          PI_WEB_HOST: "0.0.0.0",
          PI_WEB_PORT: String(PI_WEB_PORT),
          // No outbound update/version checks from inside the sandbox.
          PI_WEB_SKIP_VERSION_CHECK: "1",
          PI_WEB_OFFLINE: "1",
          ...(opts.webUiAllowedHosts
            ? { PI_WEB_ALLOWED_HOSTS: opts.webUiAllowedHosts }
            : {}),
        },
      },
    ],
    ports: [
      {
        name: "pi",
        port: PI_WEB_PORT,
        public: true,
        auth: "forward",
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
