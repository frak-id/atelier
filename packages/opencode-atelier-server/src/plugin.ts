import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { Database } from "bun:sqlite";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Atelier preregister plugin.
 *
 * Why this exists
 * ---------------
 * OpenCode derives `project_id` from `git rev-list --max-parents=0 HEAD`
 * (the root commit hash) in `Project.fromDirectory` (project/project.ts).
 * Sessions are FK-bound to `project.id` with no try/catch around the insert
 * in `session/projectors.ts:68-72`. When the local CLI warps a session via
 * `POST /sync/replay`, the event payload carries the local-side `project_id`
 * and the remote `INSERT INTO session` violates the foreign key.
 *
 * Two ways the ids can disagree:
 *   1. Atelier shallow-clones repos. Even after the fix to drop `--depth 1`,
 *      git history corruption / partial clones could still cause drift.
 *   2. The remote `Project.fromDirectory` upsert hasn't run yet at warp time
 *      (it only fires on the first interactive session/command in the dir).
 *
 * What this plugin does
 * ---------------------
 * On opencode boot, INSERT-OR-IGNORE a minimal row into the `project` table
 * directly via `bun:sqlite`, keyed by `ATELIER_SOURCE_PROJECT_ID` (set by
 * the manager's `sandbox-config.ts` from the local CLI's WorkspaceInfo).
 *
 * Why direct SQLite, not the SDK
 * -------------------------------
 * - There is no public OpenCode API to upsert a project row.
 * - Calling `Project.fromDirectory` re-runs git discovery and writes a
 *   `.git/opencode` cache. We pin that cache ourselves (see below) so
 *   when fromDirectory eventually runs in the same worktree it reads our
 *   id back instead of recomputing one that disagrees.
 *
 * Cache file pinning
 * ------------------
 * After the row is in place we also write the local project_id into
 * `<worktree>/.git/opencode`. OpenCode's `Project.fromDirectory`
 * (`project/project.ts:218,244`) checks that file before calling
 * `git rev-list --max-parents=0 HEAD`, so any later interactive session in
 * the same dir lands on the same id we just registered — no risk of a
 * second project row appearing if discovery happens to land differently.
 *
 * Schema risk
 * -----------
 * Direct DB write is brittle against opencode schema changes. We defensively
 * inspect `pragma_table_info(project)` and bail loudly if the columns we
 * write disappear or new NOT-NULL columns without defaults appear. The
 * column set is checked against `project.sql.ts` in the OpenCode version
 * pinned by atelier's `shared-binaries-job.yaml`.
 */

const PREFIX = "[atelier-preregister]";

type LogMeta = Record<string, unknown>;

function log(msg: string, meta?: LogMeta): void {
  console.log(
    `${PREFIX} ${msg}${meta ? " " + JSON.stringify(meta) : ""}`,
  );
}

/**
 * Resolve the SQLite DB path opencode would open. Mirrors XDG layout:
 *   ${XDG_DATA_HOME:-$HOME/.local/share}/opencode/storage/db.sqlite
 */
function resolveDbPath(): string {
  const xdg = process.env.XDG_DATA_HOME;
  const home = process.env.HOME ?? "/home/dev";
  const base = xdg && xdg.length > 0 ? xdg : join(home, ".local", "share");
  return join(base, "opencode", "storage", "db.sqlite");
}

/**
 * Pick the directory we'll register the project against. Order:
 *   1. ATELIER_WORKSPACE_DIRECTORY — set by the manager and matches what
 *      opencode `cd`'d into before `serve`. Most authoritative.
 *   2. PluginInput.worktree — opencode's resolved git worktree.
 *   3. PluginInput.directory — the cwd opencode was started in.
 *
 * `process.cwd()` is deliberately NOT a fallback: by plugin-load time
 * opencode has often initialized things and cwd may not match the
 * workspace path used by `Project.fromDirectory`.
 */
function resolveWorkspaceDir(input: PluginInput): string | undefined {
  const fromEnv = process.env.ATELIER_WORKSPACE_DIRECTORY;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  if (input.worktree && input.worktree.length > 0) return input.worktree;
  if (input.directory && input.directory.length > 0) return input.directory;
  return undefined;
}

/**
 * Defensive schema check: confirm `project` table has the columns we
 * write, and warn (don't fail) if there are unexpected NOT-NULL columns
 * without defaults.
 */
function schemaIsCompatible(db: Database): boolean {
  const cols = db.prepare("PRAGMA table_info(project)").all() as {
    name: string;
    notnull: number;
    dflt_value: unknown;
  }[];

  const writtenColumns = new Set([
    "id",
    "worktree",
    "vcs",
    "name",
    "sandboxes",
    "time_created",
    "time_updated",
  ]);

  const present = new Set(cols.map((c) => c.name));
  const missing = [...writtenColumns].filter((c) => !present.has(c));
  if (missing.length > 0) {
    log("schema mismatch: missing columns, skipping preregister", {
      missing,
      present: [...present],
    });
    return false;
  }

  const surprising = cols.filter(
    (c) =>
      c.notnull === 1 &&
      c.dflt_value === null &&
      !writtenColumns.has(c.name),
  );
  if (surprising.length > 0) {
    log("schema warning: NOT NULL columns without defaults we don't write", {
      columns: surprising.map((c) => c.name),
    });
    // Continue — the INSERT might still succeed, but we've logged the
    // discrepancy so an operator can investigate after a failed warp.
  }

  return true;
}

/**
 * Write `<worktree>/.git/opencode` so opencode's project discovery
 * (`Project.fromDirectory` -> `readCachedProjectId`) returns the id we
 * just inserted. Best-effort: if `.git` doesn't exist (worktree, bare
 * repo, non-git) we silently skip — the row already covers the FK case.
 */
function pinProjectIdCache(workspaceDir: string, projectID: string): void {
  const gitDir = join(workspaceDir, ".git");
  if (!existsSync(gitDir)) {
    log("no .git directory at workspace, skipping cache pin", {
      workspaceDir,
    });
    return;
  }
  try {
    writeFileSync(join(gitDir, "opencode"), projectID);
    log("pinned project_id cache file", {
      path: join(gitDir, "opencode"),
    });
  } catch (err) {
    log("failed to pin project_id cache file", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

const ATELIER_PRE_REGISTER_PLUGIN: Plugin = async (input: PluginInput) => {
  const sourceProjectID = process.env.ATELIER_SOURCE_PROJECT_ID;
  if (!sourceProjectID) {
    log("ATELIER_SOURCE_PROJECT_ID not set, plugin is a no-op");
    return {};
  }

  const workspaceDir = resolveWorkspaceDir(input);
  if (!workspaceDir) {
    log("could not determine workspace directory, skipping", {
      env_dir: process.env.ATELIER_WORKSPACE_DIRECTORY,
      input_worktree: input.worktree,
      input_directory: input.directory,
    });
    return {};
  }

  // Pin the cache file unconditionally (idempotent) so any future
  // `Project.fromDirectory` run in this worktree resolves to our id.
  // Doing this before the DB step means it still happens even if the
  // DB is missing or the schema check bails.
  pinProjectIdCache(workspaceDir, sourceProjectID);

  const dbPath = resolveDbPath();
  if (!existsSync(dbPath)) {
    // OpenCode creates the DB on first storage hit, well before any plugin
    // loads. Missing here means the install is broken in a way we can't
    // fix from a plugin.
    log("opencode sqlite db not found, skipping preregister", { dbPath });
    return {};
  }

  let db: Database | undefined;
  try {
    db = new Database(dbPath);
    db.exec("PRAGMA foreign_keys = ON");

    if (!schemaIsCompatible(db)) {
      return {};
    }

    const existing = db
      .prepare("SELECT id FROM project WHERE id = ?")
      .get(sourceProjectID) as { id: string } | undefined;

    if (existing) {
      log("project_id already present, no aliasing needed", {
        projectID: sourceProjectID,
      });
      return {};
    }

    const now = Date.now();
    db.prepare(
      `INSERT OR IGNORE INTO project
        (id, worktree, vcs, name, sandboxes, time_created, time_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sourceProjectID,
      workspaceDir,
      "git",
      null,
      // sandboxes column is `text({ mode: "json" })` per project.sql.ts —
      // bun:sqlite doesn't auto-serialize, so we hand-encode an empty array.
      JSON.stringify([]),
      now,
      now,
    );

    log("aliased local project_id into remote DB", {
      projectID: sourceProjectID,
      worktree: workspaceDir,
    });
  } catch (err) {
    // Don't let a preregister failure crash opencode boot. Worst case
    // is the user gets the original FK error on warp, which they'd have
    // gotten without the plugin anyway.
    log("failed to preregister project_id", {
      error: err instanceof Error ? err.message : String(err),
      projectID: sourceProjectID,
    });
  } finally {
    db?.close();
  }

  return {};
};

export default ATELIER_PRE_REGISTER_PLUGIN;
