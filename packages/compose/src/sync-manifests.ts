/**
 * Local-config sync manifests — "sync my local agent config into a sandbox"
 * as a CLI primitive (atelier-v2 §1 gap list; §4 `atelier sync`). Each
 * manifest lists the local paths `atelier sync <name> <sandbox>:<path>`
 * walks; the CLI diffs them against the sandbox and pushes via
 * `PATCH /v1/sandboxes/:id/files`.
 *
 * This is the source of truth for which paths a named local tool's config
 * lives under — kept here (not in the runtime, which never knows what
 * "opencode" or "claude" is) so every client (CLI, dashboard, company
 * scripts) shares one list.
 */
export interface SyncManifest {
  /** Local paths (may contain `~`) this manifest syncs, relative to $HOME. */
  paths: string[];
}

export const SYNC_MANIFESTS: Record<string, SyncManifest> = {
  claude: {
    paths: ["~/.claude"],
  },
  opencode: {
    paths: ["~/.config/opencode", "~/.local/share/opencode/auth.json"],
  },
  pi: {
    paths: ["~/.config/pi"],
  },
};

/** Resolve a named sync manifest. Returns `undefined` for unknown names. */
export function resolveSyncManifest(name: string): SyncManifest | undefined {
  return SYNC_MANIFESTS[name];
}
