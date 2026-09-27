/** Orchestrates one sync pass over every configured repo: skip-if-unchanged,
 * fetch, run CodeWiki, diff pages against saved state, push only what
 * changed to Onyx, and persist the new state atomically. One repo's failure
 * never stops the others. Also reconciles `DATA_DIR/state/` against the
 * current `CODEWIKI_REPOS` list, deleting Onyx pages (and local state) for
 * any repo that's been removed from config — see {@link cleanupOrphanedState}. */

import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runCodewiki } from "./codewiki.ts";
import type { RepoRef, SyncConfig } from "./config.ts";
import { fetchBranch, remoteHeadSha } from "./git.ts";
import { OnyxClient } from "./onyx.ts";
import { buildDocumentsFromWiki, readCommit } from "./pages.ts";

export interface RepoState {
  lastCommit: string;
  /** document id -> content hash, as of the last successful sync. */
  pages: Record<string, string>;
}

type RepoDirKey = Pick<RepoRef, "owner" | "repo">;

function statePathFor(dataDir: string, ref: RepoDirKey): string {
  return path.join(dataDir, "state", `${ref.owner}__${ref.repo}.json`);
}

function checkoutDirFor(dataDir: string, ref: RepoDirKey): string {
  return path.join(dataDir, "repos", ref.owner, ref.repo);
}

function wikiDirFor(dataDir: string, ref: RepoDirKey): string {
  return path.join(dataDir, "wiki", ref.owner, ref.repo);
}

async function wikiDirHasPages(wikiDir: string): Promise<boolean> {
  try {
    const entries = await readdir(wikiDir);
    return entries.some((name) => name.endsWith(".md"));
  } catch {
    return false;
  }
}

export async function loadState(
  statePath: string,
): Promise<RepoState | undefined> {
  try {
    const raw = await readFile(statePath, "utf8");
    return JSON.parse(raw) as RepoState;
  } catch {
    return undefined;
  }
}

/** Atomic write: write to a sibling temp file, then rename over the target
 * so a crash mid-write never leaves a corrupt state file. */
export async function saveState(
  statePath: string,
  state: RepoState,
): Promise<void> {
  await mkdir(path.dirname(statePath), { recursive: true });
  const tmpPath = `${statePath}.tmp-${process.pid}`;
  await writeFile(tmpPath, JSON.stringify(state, null, 2));
  await rename(tmpPath, statePath);
}

export interface PageDiff {
  upsertIds: string[];
  deleteIds: string[];
}

/** Compares the freshly generated pages' hashes against the last-synced
 * state: upsert anything new/changed, delete anything that disappeared. */
export function diffPages(
  currentHashes: Record<string, string>,
  previous: RepoState | undefined,
): PageDiff {
  const prevPages = previous?.pages ?? {};
  const upsertIds: string[] = [];
  for (const [id, hash] of Object.entries(currentHashes)) {
    if (prevPages[id] !== hash) upsertIds.push(id);
  }
  const currentIds = new Set(Object.keys(currentHashes));
  const deleteIds = Object.keys(prevPages).filter((id) => !currentIds.has(id));
  return { upsertIds, deleteIds };
}

export interface GitOps {
  remoteHeadSha: typeof remoteHeadSha;
  fetchBranch: typeof fetchBranch;
}

export const defaultGitOps: GitOps = { remoteHeadSha, fetchBranch };

export interface CodewikiOps {
  run: typeof runCodewiki;
}

export const defaultCodewikiOps: CodewikiOps = { run: runCodewiki };

export interface OnyxOps {
  upsert(doc: Parameters<OnyxClient["upsert"]>[0]): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface SyncOneOptions {
  config: SyncConfig;
  ref: RepoRef;
  /** Force a sync even if the remote HEAD sha matches saved state. */
  force?: boolean;
  /** Use this directory as the checkout instead of cloning into DATA_DIR
   * (local/dev mode — `--path <dir> --repo <owner/repo>`). */
  localPath?: string;
  /** Skip invoking the `codewiki` CLI and read whatever's already in the
   * wiki dir (dry-run fixtures / tests). */
  skipGenerate?: boolean;
  log?: (line: string) => void;
  git?: GitOps;
  codewiki?: CodewikiOps;
  onyx?: OnyxOps;
}

export type SyncOneResult =
  | { repo: string; status: "skipped"; reason: string }
  | {
      repo: string;
      status: "synced";
      upserted: string[];
      deleted: string[];
      commit: string | undefined;
    }
  | { repo: string; status: "failed"; error: string };

export async function syncOne(opts: SyncOneOptions): Promise<SyncOneResult> {
  const { config, ref } = opts;
  const repoLabel = `${ref.owner}/${ref.repo}`;
  const log = opts.log ?? (() => {});
  const git = opts.git ?? defaultGitOps;
  const codewiki = opts.codewiki ?? defaultCodewikiOps;

  const statePath = statePathFor(config.dataDir, ref);
  const checkoutDir = opts.localPath ?? checkoutDirFor(config.dataDir, ref);
  const wikiDir = wikiDirFor(config.dataDir, ref);

  try {
    const previousState = await loadState(statePath);

    if (!opts.localPath && !opts.force) {
      const remoteSha = await git.remoteHeadSha(ref, config.githubToken);
      if (previousState?.lastCommit === remoteSha) {
        return {
          repo: repoLabel,
          status: "skipped",
          reason: `unchanged at ${remoteSha.slice(0, 8)}`,
        };
      }
    }

    if (!opts.localPath) {
      log(`fetching ${repoLabel}@${ref.branch}`);
      await git.fetchBranch(ref, checkoutDir, config.githubToken);
    }

    let hasPreviousOutput = false;
    try {
      await readFile(path.join(wikiDir, "metadata.json"), "utf8");
      hasPreviousOutput = true;
    } catch {
      hasPreviousOutput = false;
    }
    const hasExistingPages = await wikiDirHasPages(wikiDir);

    if (!opts.skipGenerate) {
      if (!config.llmApiKey) {
        throw new Error("LLM_API_KEY is required to run codewiki generate");
      }
      await mkdir(wikiDir, { recursive: true });
      // Ephemeral, per-run HOME: `~/.codewiki/credentials.json` (written by
      // runCodewiki) must never land on the PVC (DATA_DIR), only in
      // container-local /tmp — see git.ts/codewiki.ts headers and the
      // README's "Secrets" section. Removed in `finally` regardless of
      // outcome.
      const homeDir = await mkdtemp(path.join(tmpdir(), "codewiki-home-"));
      try {
        const result = await codewiki.run(
          {
            homeDir,
            llmBaseUrl: config.llmBaseUrl,
            llmApiKey: config.llmApiKey,
            mainModel: config.codewikiModel,
            fallbackModel: config.codewikiFallbackModel,
            maxTokens: config.codewikiMaxTokens,
            exclude: config.codewikiExclude,
            checkoutDir,
            wikiDir,
            hasPreviousOutput,
            hasExistingPages,
          },
          log,
        );
        if (!result.ok) {
          throw new Error(`codewiki generate failed for ${repoLabel}`);
        }
      } finally {
        await rm(homeDir, { recursive: true, force: true });
      }
    }

    const generatedAt = new Date().toISOString();
    const { documents, commit: wikiCommit } = await buildDocumentsFromWiki(
      ref.owner,
      ref.repo,
      wikiDir,
      generatedAt,
    );
    const commit = wikiCommit ?? (await readCommit(wikiDir));

    const currentHashes: Record<string, string> = {};
    for (const doc of documents) {
      currentHashes[doc.id] = hashDocument(doc);
    }
    const diff = diffPages(currentHashes, previousState);

    const documentsById = new Map(documents.map((d) => [d.id, d]));

    if (config.dryRun) {
      log(
        `[dry-run] ${repoLabel}: would upsert ${diff.upsertIds.length} ` +
          `page(s), delete ${diff.deleteIds.length} page(s)`,
      );
      for (const id of diff.upsertIds) log(`[dry-run]   upsert ${id}`);
      for (const id of diff.deleteIds) log(`[dry-run]   delete ${id}`);
    } else {
      const onyx = opts.onyx ?? onyxOpsFor(config);
      // Persist state after every individual upsert/delete (not just once
      // at the end): if this loop dies partway through (Onyx 5xx after
      // retries, OOM, pod eviction), the next run's diff starts from
      // whatever actually landed instead of redoing already-applied
      // changes. `commit` is only recorded once every page op succeeds, so
      // a crash mid-loop still re-checks the same commit next time (safe:
      // `pages` already reflects real progress, so the diff against it is
      // small).
      const workingState: RepoState = {
        lastCommit: previousState?.lastCommit ?? "",
        pages: { ...(previousState?.pages ?? {}) },
      };
      for (const id of diff.upsertIds) {
        const doc = documentsById.get(id);
        if (!doc) continue;
        await onyx.upsert(doc);
        workingState.pages[id] = currentHashes[id] as string;
        await saveState(statePath, workingState);
      }
      for (const id of diff.deleteIds) {
        // OnyxClient.delete treats 404 as success (idempotent) — a delete
        // that's already happened (e.g. a previous crashed run got this far
        // but died before saveState) is not an error here.
        await onyx.delete(id);
        delete workingState.pages[id];
        await saveState(statePath, workingState);
      }
      workingState.lastCommit = commit ?? previousState?.lastCommit ?? "";
      await saveState(statePath, workingState);
    }

    return {
      repo: repoLabel,
      status: "synced",
      upserted: diff.upsertIds,
      deleted: diff.deleteIds,
      commit,
    };
  } catch (err) {
    return {
      repo: repoLabel,
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * What decides whether a page is re-pushed: the section texts. Links and the
 * commit sha are left out on purpose: a new commit that leaves a page's text
 * unchanged does not re-embed it, and its link keeps pointing at the commit
 * the text was written from.
 */
function hashDocument(doc: { sections: { text: string }[] }): string {
  const hasher = new Bun.CryptoHasher("sha256");
  for (const section of doc.sections) {
    hasher.update(section.text);
    hasher.update("\u0000");
  }
  return hasher.digest("hex");
}

function onyxOpsFor(config: SyncConfig): OnyxOps {
  if (
    !config.onyxUrl ||
    !config.onyxApiKey ||
    config.onyxCcPairId === undefined
  ) {
    throw new Error("ONYX_URL, ONYX_API_KEY and ONYX_CC_PAIR_ID are required");
  }
  const client = new OnyxClient({
    baseUrl: config.onyxUrl,
    apiKey: config.onyxApiKey,
    ccPairId: config.onyxCcPairId,
  });
  return {
    upsert: (doc) => client.upsert(doc),
    delete: (id) => client.delete(id),
  };
}

interface StateFileEntry {
  path: string;
  owner: string;
  repo: string;
}

async function listStateFiles(dataDir: string): Promise<StateFileEntry[]> {
  const stateDir = path.join(dataDir, "state");
  let names: string[];
  try {
    names = await readdir(stateDir);
  } catch {
    return [];
  }
  const entries: StateFileEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name.endsWith(".json.tmp")) continue;
    const stem = name.slice(0, -".json".length);
    const sepIndex = stem.indexOf("__");
    if (sepIndex === -1) continue;
    const owner = stem.slice(0, sepIndex);
    const repo = stem.slice(sepIndex + 2);
    if (!owner || !repo) continue;
    entries.push({ path: path.join(stateDir, name), owner, repo });
  }
  return entries;
}

/** Validates that a parsed JSON value has exactly the shape {@link saveState}
 * writes (`{lastCommit: string, pages: Record<string,string>}`) — guards
 * {@link cleanupOrphanedState} against acting on a file under
 * `DATA_DIR/state/` that this tool didn't write, or a corrupted one. */
function isRepoState(value: unknown): value is RepoState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.lastCommit !== "string") return false;
  if (
    typeof v.pages !== "object" ||
    v.pages === null ||
    Array.isArray(v.pages)
  ) {
    return false;
  }
  return Object.values(v.pages as Record<string, unknown>).every(
    (hash) => typeof hash === "string",
  );
}

export interface OrphanResult {
  repo: string;
  status: "removed" | "failed";
  deleted: string[];
  error?: string;
}

/** A repo dropped from `CODEWIKI_REPOS` keeps its state file and its Onyx
 * pages forever unless something reconciles `DATA_DIR/state/` against the
 * current config — this does that: for every `state/<owner>__<repo>.json`
 * whose repo is no longer in `configuredRepos`, deletes each page id in its
 * `pages` map from Onyx, then removes the state file and (best-effort) the
 * repo's checkout/wiki dirs. `DRY_RUN` only logs what would be removed. */
export async function cleanupOrphanedState(
  config: SyncConfig,
  configuredRepos: RepoRef[],
  onyx: OnyxOps,
  log: (line: string) => void,
): Promise<OrphanResult[]> {
  const configured = new Set(
    configuredRepos.map((r) => `${r.owner}/${r.repo}`),
  );
  const entries = await listStateFiles(config.dataDir);
  const results: OrphanResult[] = [];

  for (const entry of entries) {
    const repoLabel = `${entry.owner}/${entry.repo}`;
    if (configured.has(repoLabel)) continue;

    let state: RepoState;
    try {
      const raw = await readFile(entry.path, "utf8");
      const parsed = JSON.parse(raw);
      if (!isRepoState(parsed)) {
        log(
          `[orphan] ${repoLabel}: state file has an unexpected shape, ` +
            "leaving it alone",
        );
        continue;
      }
      state = parsed;
    } catch (err) {
      log(
        `[orphan] ${repoLabel}: could not read state file, leaving it ` +
          `alone (${err instanceof Error ? err.message : String(err)})`,
      );
      continue;
    }

    const ids = Object.keys(state.pages);

    if (config.dryRun) {
      log(
        `[dry-run] ${repoLabel}: no longer in CODEWIKI_REPOS — would ` +
          `delete ${ids.length} page(s) and its state file`,
      );
      results.push({ repo: repoLabel, status: "removed", deleted: ids });
      continue;
    }

    const deleted: string[] = [];
    try {
      for (const id of ids) {
        await onyx.delete(id);
        deleted.push(id);
      }
      await rm(entry.path, { force: true });
      await rm(checkoutDirFor(config.dataDir, entry), {
        recursive: true,
        force: true,
      });
      await rm(wikiDirFor(config.dataDir, entry), {
        recursive: true,
        force: true,
      });
      log(
        `[orphan] ${repoLabel}: removed ${deleted.length} page(s) and its ` +
          "state file (no longer in CODEWIKI_REPOS)",
      );
      results.push({ repo: repoLabel, status: "removed", deleted });
    } catch (err) {
      results.push({
        repo: repoLabel,
        status: "failed",
        deleted,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

export interface SyncAllOptions {
  config: SyncConfig;
  force?: boolean;
  onlyRepo?: string;
  localPath?: string;
  skipGenerate?: boolean;
  log?: (line: string) => void;
  git?: GitOps;
  codewiki?: CodewikiOps;
  onyx?: OnyxOps;
}

export interface SyncAllResult {
  results: SyncOneResult[];
  /** Repos found under `DATA_DIR/state/` that are no longer in
   * `CODEWIKI_REPOS` and were reconciled (or attempted to be) — see
   * {@link cleanupOrphanedState}. Always empty in local/dev mode
   * (`--path`), since that operates on a single ad hoc checkout, not the
   * full `DATA_DIR` the CronJob manages. */
  orphans: OrphanResult[];
  failed: boolean;
}

/** Runs {@link syncOne} for every configured repo (or just `onlyRepo`),
 * never letting one repo's failure abort the rest, then reconciles orphaned
 * state (see {@link cleanupOrphanedState}). */
export async function syncAll(opts: SyncAllOptions): Promise<SyncAllResult> {
  const targets = opts.onlyRepo
    ? opts.config.repos.filter((r) => `${r.owner}/${r.repo}` === opts.onlyRepo)
    : opts.config.repos;

  if (opts.onlyRepo && targets.length === 0) {
    return {
      results: [
        {
          repo: opts.onlyRepo,
          status: "failed",
          error: "repo not in CODEWIKI_REPOS",
        },
      ],
      orphans: [],
      failed: true,
    };
  }

  const results: SyncOneResult[] = [];
  for (const ref of targets) {
    const result = await syncOne({
      config: opts.config,
      ref,
      force: opts.force,
      localPath: opts.localPath,
      skipGenerate: opts.skipGenerate,
      log: opts.log,
      git: opts.git,
      codewiki: opts.codewiki,
      onyx: opts.onyx,
    });
    results.push(result);
  }

  let orphans: OrphanResult[] = [];
  if (!opts.localPath) {
    const log = opts.log ?? (() => {});
    try {
      const onyx =
        opts.onyx ??
        (opts.config.dryRun
          ? { upsert: async () => {}, delete: async () => {} }
          : onyxOpsFor(opts.config));
      orphans = await cleanupOrphanedState(
        opts.config,
        opts.config.repos,
        onyx,
        log,
      );
    } catch (err) {
      orphans = [
        {
          repo: "orphan-cleanup",
          status: "failed",
          deleted: [],
          error: err instanceof Error ? err.message : String(err),
        },
      ];
    }
  }

  return {
    results,
    orphans,
    failed:
      results.some((r) => r.status === "failed") ||
      orphans.some((o) => o.status === "failed"),
  };
}
