import { VM } from "@frak/atelier-shared/constants";

/**
 * Where a harness's shared binaries live inside the pod (pre-staged catalog on
 * the read-only shared PVC). Adapters build their ACP launch command from here.
 */
const SHARED_BIN_DIR = "/opt/shared/bin";

/** The model/agent selection a session was configured with, harness-neutral. */
export interface AgentModelSelection {
  model?: { providerID: string; modelID: string };
  agent?: string;
}

/**
 * An ACP `session/set_config_option` assignment: a config id (e.g. "model",
 * "mode") and the value id to select for it.
 */
export interface SessionConfigAssignment {
  configId: string;
  value: string;
}

/**
 * A HarnessAdapter encapsulates everything specific to one ACP coding agent
 * (opencode, claude-code, codex, pi, …). The manager's ACP client
 * (AgentDispatch) and the tool registry stay agent-neutral by going through
 * this interface, so adding a harness is adding an entry here — not touching
 * call sites.
 *
 * ACP itself is the integration contract; an adapter only fills the gaps ACP
 * leaves harness-specific: the launch command, config/auth file locations, and
 * how model/agent selection is expressed (which ACP does not standardize).
 */
export interface HarnessAdapter {
  /** Stable catalog id, e.g. "opencode". */
  readonly id: string;

  /** Command that launches the ACP harness on stdio inside the pod. */
  acpCommand(): string;

  /**
   * Translate a manager-side model/agent selection into ACP
   * `session/set_config_option` assignments, applied at the start of a session.
   * ACP has no standard model field: selection is done via the `configOptions`
   * a harness advertises on `session/new` and changed with
   * `session/set_config_option`. Adapters that don't support selection return [].
   */
  sessionConfig?(selection: AgentModelSelection): SessionConfigAssignment[];

  /** Path to the harness's own MCP/config file, for dual MCP delivery (§6.3). */
  readonly configPath?: string;
  /** Path to the harness's auth/credential file, for auth-sync. */
  readonly authPath?: string;

  /**
   * The harness config file that cliproxy provider settings are injected into,
   * in `~/`-relative form (matches ConfigFileService path keys). Undefined if
   * the harness has no such surface.
   */
  readonly proxyConfigFile?: string;
  /**
   * Merge cliproxy provider configs into this harness's config file content,
   * returning the new file content. `existing` is the current JSON content, or
   * undefined if the file doesn't exist yet. The merge shape is the harness's
   * own config schema.
   */
  mergeProxyProviders?(
    providers: Record<string, unknown>,
    existing: string | undefined,
  ): string;
}

/**
 * Declarative harness definition. Most harnesses differ only in data (id,
 * launch binary, config/auth paths), so they share one adapter implementation;
 * only genuinely behavioural bits (e.g. how a model is selected) are functions.
 */
interface HarnessSpec {
  id: string;
  /** Executable (with optional subcommand) under the shared bin dir. */
  command: string;
  configPath?: string;
  authPath?: string;
  proxyConfigFile?: string;
  sessionConfig?: (selection: AgentModelSelection) => SessionConfigAssignment[];
  mergeProxyProviders?: (
    providers: Record<string, unknown>,
    existing: string | undefined,
  ) => string;
}

class SpecHarnessAdapter implements HarnessAdapter {
  constructor(private readonly spec: HarnessSpec) {}

  get id(): string {
    return this.spec.id;
  }
  get configPath(): string | undefined {
    return this.spec.configPath;
  }
  get authPath(): string | undefined {
    return this.spec.authPath;
  }
  get proxyConfigFile(): string | undefined {
    return this.spec.proxyConfigFile;
  }

  acpCommand(): string {
    return `${SHARED_BIN_DIR}/${this.spec.command}`;
  }

  sessionConfig(selection: AgentModelSelection): SessionConfigAssignment[] {
    return this.spec.sessionConfig?.(selection) ?? [];
  }

  mergeProxyProviders(
    providers: Record<string, unknown>,
    existing: string | undefined,
  ): string {
    return (
      this.spec.mergeProxyProviders?.(providers, existing) ??
      JSON.stringify({ provider: providers })
    );
  }
}

// Merge cliproxy providers into opencode's config schema (`{ provider: {...} }`).
// Throws on malformed existing JSON so the caller can leave the file untouched
// and warn (rather than clobbering a corrupt config with a fresh document).
function opencodeMergeProxyProviders(
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

// OpenCode selects model/agent via session/set_config_option (verified against
// opencode 1.17.10): configId "model" takes a flat "provider/model" value id,
// and its "mode" option is the analog of a named agent. `_meta` on prompt is
// silently ignored, so selection must go through set_config_option.
function opencodeSessionConfig(
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

// The launch set. opencode is native ACP; the others reach ACP via their
// community/official adapters (see the ACP proposal's agent support matrix) and
// are pre-staged in the shared-bin catalog. config/auth paths are filled in as
// each harness's config-file/auth-sync injection is wired up.
const HARNESS_SPECS: HarnessSpec[] = [
  {
    id: "opencode",
    command: "opencode acp",
    configPath: `${VM.HOME}/.config/opencode/opencode.json`,
    authPath: `${VM.HOME}/.local/share/opencode/auth.json`,
    proxyConfigFile: "~/.config/opencode/opencode.json",
    sessionConfig: opencodeSessionConfig,
    mergeProxyProviders: opencodeMergeProxyProviders,
  },
  { id: "claude-code", command: "claude-agent-acp" },
  { id: "codex", command: "codex-acp" },
  { id: "pi", command: "pi-acp" },
];

const DEFAULT_HARNESS_ID = "opencode";
const HARNESS_ADAPTERS: Record<string, HarnessAdapter> = Object.fromEntries(
  HARNESS_SPECS.map((spec) => [spec.id, new SpecHarnessAdapter(spec)]),
);

export function resolveHarness(id: string | undefined): HarnessAdapter {
  const harness = HARNESS_ADAPTERS[id ?? DEFAULT_HARNESS_ID];
  if (!harness) {
    throw new Error(`Unknown harness "${id}"`);
  }
  return harness;
}
