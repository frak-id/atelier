/**
 * The opencode harness composer — ported from
 * `apps/manager/src/shared/agent/harness-adapter.ts` (`OPENCODE_HARNESS`,
 * `opencodeMergeProxyProviders`, `opencodeSessionConfig`). Self-contained:
 * no manager imports, no `@opencode-ai/sdk` (session-surface / ACP-client
 * concerns live in `apps/server/src/sessions`, not in spec composition).
 *
 * "opencode with these MCP servers" → files + the acp process + annotations
 * (atelier-v2 §3).
 */
import type { HarnessComposer } from "../harness.ts";
import type { SpecFragment } from "../spec-merge.ts";

const HOME = "/home/dev";
const SHARED_BIN_DIR = "/opt/shared/bin";
const OPENCODE_CONFIG_PATH = `${HOME}/.config/opencode/opencode.json`;
const OPENCODE_AUTH_PATH = `${HOME}/.local/share/opencode/auth.json`;

/** The model/agent selection a session was configured with, harness-neutral. */
export interface AgentModelSelection {
  model?: { providerID: string; modelID: string };
  agent?: string;
}

/** An ACP `session/set_config_option` assignment. */
export interface SessionConfigAssignment {
  configId: string;
  value: string;
}

/**
 * Merge cliproxy-style provider configs into opencode's config schema
 * (`{ provider: {...} }`). Throws on malformed existing JSON so the caller
 * can leave the file untouched and warn, rather than clobbering a corrupt
 * config with a fresh document.
 */
export function opencodeMergeProxyProviders(
  providers: Record<string, unknown>,
  existing: string | undefined,
): string {
  const parsed: Record<string, unknown> = existing
    ? (JSON.parse(existing) as Record<string, unknown>)
    : {};
  const existingProvider = (parsed.provider as Record<string, unknown>) ?? {};
  parsed.provider = { ...existingProvider, ...providers };
  return JSON.stringify(parsed);
}

/**
 * OpenCode selects model/agent via `session/set_config_option` (verified
 * against opencode 1.17.10): configId "model" takes a flat "provider/model"
 * value id, and its "mode" option is the analog of a named agent.
 */
export function opencodeSessionConfig(
  selection: AgentModelSelection,
): SessionConfigAssignment[] {
  const assignments: SessionConfigAssignment[] = [];
  if (selection.model) {
    assignments.push({
      configId: "model",
      value: `${selection.model.providerID}/${selection.model.modelID}`,
    });
  }
  if (selection.agent) {
    assignments.push({ configId: "mode", value: selection.agent });
  }
  return assignments;
}

export interface ComposeOpencodeOptions {
  /** MCP server names to record in the `atelier.dev/mcp` annotation. */
  mcp?: string[];
  /** Provider config merged into `opencode.json`'s `{ provider: {...} }`. */
  providers?: Record<string, unknown>;
  /** Extra opencode config merged alongside `provider`. */
  config?: Record<string, unknown>;
}

/**
 * Compose opencode's spec fragment: the `acp` process (stdio-bridged,
 * primary — the sandbox's health gate) plus its config file and display
 * annotations.
 */
export function composeOpencode(
  opts: ComposeOpencodeOptions = {},
): SpecFragment {
  const configContent = opencodeMergeProxyProviders(
    opts.providers ?? {},
    opts.config ? JSON.stringify(opts.config) : undefined,
  );

  return {
    processes: [
      {
        name: "acp",
        command: `${SHARED_BIN_DIR}/opencode acp`,
        cwd: HOME,
        stdio: "bridge",
        primary: true,
      },
    ],
    files: [
      {
        path: OPENCODE_CONFIG_PATH,
        content: configContent,
        owner: "dev",
      },
    ],
    annotations: {
      "atelier.dev/harness": "opencode",
      ...(opts.mcp && opts.mcp.length > 0
        ? { "atelier.dev/mcp": opts.mcp.join(",") }
        : {}),
    },
  };
}

/** Paths kept for callers that need them outside `compose()` (e.g. auth-sync). */
export const OPENCODE_PATHS = {
  configPath: OPENCODE_CONFIG_PATH,
  authPath: OPENCODE_AUTH_PATH,
};

/**
 * The registrable composer. Not auto-registered here — the server/CLI
 * bootstrap calls `registerHarness(opencodeHarness)` (atelier-v2 §3: harness
 * registration is client-side wiring, not runtime machinery).
 */
export const opencodeHarness: HarnessComposer = {
  id: "opencode",
  compose: (opts) =>
    composeOpencode(opts as ComposeOpencodeOptions | undefined),
};
