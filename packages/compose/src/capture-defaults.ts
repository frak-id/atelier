/**
 * Per-harness capture defaults (composed-prebuild-volumes.md §2, §6.6
 * "capture"). Path-selection is what makes capture usable — a naive
 * full-home diff would capture cache garbage and logs, and worse, it would
 * capture credentials. This is content knowledge (which paths a harness
 * touches, which of those are secret files), so it lives here in
 * `@atelier/compose`, not in `runtime/` or the agent: the runtime's capture
 * mechanism (`captureToolset`) only ever sees `paths[]`/`exclude[]` strings
 * it doesn't interpret.
 *
 * These are DEFAULTS — a dev can add/remove paths when they call
 * `atelier toolset capture`; the built-in secret-file excludes (`auth.json`,
 * `.env*`, `id_rsa`, …, `apps/agent-v2/src/toolset.rs` `DEFAULT_EXCLUDES`)
 * apply unconditionally on top of whatever is listed here — this module
 * only adds harness-specific exclusions the agent's generic floor can't know
 * (e.g. opencode's `auth.json` living under a harness-specific config dir).
 */

export interface CaptureDefaults {
  /** Home path-sets a capture of this harness should include by default. */
  paths: string[];
  /** Additional exclude globs beyond the agent's built-in secret-file floor. */
  exclude: string[];
}

const OPENCODE_DEFAULTS: CaptureDefaults = {
  paths: ["~/.config/opencode", "~/.local/share/opencode"],
  exclude: ["auth.json"],
};

const CLAUDE_CODE_DEFAULTS: CaptureDefaults = {
  paths: ["~/.claude", "~/.local/bin/claude"],
  exclude: [".credentials.json", ".claude.json"],
};

const PI_DEFAULTS: CaptureDefaults = {
  paths: ["~/.config/pi", "~/.local/share/pi", "~/.local/bin/pi"],
  exclude: ["auth.json", ".env"],
};

/** A conservative fallback for an unregistered harness id: no default paths
 * (a dev must name their own), and no harness-specific excludes beyond the
 * agent's built-in secret-file floor. */
const GENERIC_DEFAULTS: CaptureDefaults = { paths: [], exclude: [] };

const HARNESS_CAPTURE_DEFAULTS: Record<string, CaptureDefaults> = {
  opencode: OPENCODE_DEFAULTS,
  "claude-code": CLAUDE_CODE_DEFAULTS,
  pi: PI_DEFAULTS,
};

/** Registered per-harness capture defaults, keyed by harness id. Exported for
 * callers that want to enumerate/inspect rather than resolve a single id. */
export const harnessCaptureDefaults: Readonly<Record<string, CaptureDefaults>> =
  HARNESS_CAPTURE_DEFAULTS;

/** Resolve capture defaults for a harness id, falling back to
 * {@link GENERIC_DEFAULTS} for one with no registered defaults (a dev must
 * supply `paths[]` explicitly in that case — never silently captures
 * nothing they didn't ask for, but also never guesses). */
export function captureDefaultsFor(harness: string): CaptureDefaults {
  return HARNESS_CAPTURE_DEFAULTS[harness] ?? GENERIC_DEFAULTS;
}
