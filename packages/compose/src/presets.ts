/**
 * Preset snippets — the client-side demotion of v1's `BUILTIN_TOOLS`
 * (atelier-v2 §3: "the preset snippets (today's `BUILTIN_TOOLS`: vscode,
 * browser, terminal — each a function returning spec pieces)"). Each preset
 * is a plain function returning a `SpecFragment`; "add vscode" is appending
 * one process + one port, nothing the runtime has an opinion about.
 *
 * Commands/ports are carried over verbatim from
 * `apps/manager/src/orchestrators/tools/registry.ts` (`BUILTIN_TOOLS`) so
 * existing dev-base images keep working unmodified.
 */
import type { SpecFragment } from "./spec-merge.ts";

const HOME = "/home/dev";

/** VS Code, lazily started (socket-activation style), forward-auth'd. */
export function vscode(options?: {
  workspaceDir?: string;
  port?: number;
}): SpecFragment {
  const workspaceDir = options?.workspaceDir ?? HOME;
  const port = options?.port ?? 8080;
  return {
    processes: [
      {
        name: "vscode",
        // Bare command: the org toolbox toolset materializes code-server onto
        // PATH via the dev-base `~/.local/bin` shim.
        command:
          `code-server --bind-addr 0.0.0.0:${port} ` +
          `--auth none --disable-telemetry ${workspaceDir}`,
        lazy: true,
        readiness: { port },
      },
    ],
    ports: [{ name: "vscode", port, public: true, auth: "forward" }],
  };
}

/**
 * The in-pod terminal multiplexer. Agent-managed in v1 (the guest agent
 * ensures it itself, contributing no manager-started service) — kept as a
 * thin, non-lazy declaration so a spec that wants a terminal surface can
 * still say so; the runtime's PTY attach mode is the actual mechanism
 * (atelier-v2 §2 "One supervisor, three attachment modes").
 */
export function terminal(options?: { port?: number }): SpecFragment {
  const port = options?.port ?? 7681;
  return {
    processes: [
      {
        name: "terminal",
        // Agent-managed: the guest agent owns the terminal multiplexer
        // process itself. Empty command is intentional — this entry exists
        // so the spec can still declare `after: ["terminal"]` /
        // annotate the surface; it carries no manager-launched command.
        command: "",
        restart: "always",
        readiness: { port },
      },
    ],
  };
}

/** The "browser tool": three processes + a port (kasmvnc, openbox, chromium). */
export function browser(options?: { port?: number }): SpecFragment {
  const port = options?.port ?? 6080;
  return {
    processes: [
      {
        name: "kasmvnc",
        command:
          `Xvnc :99 -geometry 1280x900 -depth 24 -websocketPort ${port} ` +
          "-SecurityTypes None -AlwaysShared -AcceptSetDesktopSize " +
          "-DisableBasicAuth -UseIPv6 0 -interface 0.0.0.0 " +
          "-httpd /usr/share/kasmvnc/www -FrameRate 60 -DynamicQualityMin 7 " +
          "-DynamicQualityMax 9 -RectThreads 0 -CompareFB 2 -DetectScrolling " +
          "-sslOnly 0",
        lazy: true,
        readiness: { port },
      },
      {
        name: "openbox",
        command: "openbox",
        env: { DISPLAY: ":99" },
        lazy: true,
        after: ["kasmvnc"],
      },
      {
        name: "chromium",
        command:
          "chromium --disable-gpu --disable-software-rasterizer " +
          "--disable-dev-shm-usage --no-first-run " +
          "--disable-session-crashed-bubble --disable-infobars " +
          "--disable-translate --disable-features=TranslateUI " +
          "--password-store=basic --disable-background-networking " +
          "--disable-sync --disable-extensions --disable-default-apps " +
          "--disable-breakpad " +
          "--disable-component-extensions-with-background-pages " +
          "--disable-background-timer-throttling " +
          "--force-device-scale-factor=1 --disable-lcd-text " +
          "--renderer-process-limit=2 --disk-cache-size=104857600 " +
          "--user-data-dir=/tmp/chromium-profile about:blank",
        env: { DISPLAY: ":99" },
        lazy: true,
        after: ["openbox"],
      },
    ],
    ports: [{ name: "browser", port, public: true, auth: "forward" }],
  };
}

export const PRESETS = { vscode, terminal, browser };
