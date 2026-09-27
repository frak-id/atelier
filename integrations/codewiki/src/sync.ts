/** Orchestrates one sync pass over every configured repo: skip-if-unchanged,
 * fetch, run CodeWiki, diff pages against saved state, push only what
 * changed to Onyx, and persist the new state atomically. One repo's failure
 * never stops the others. */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

function statePathFor(dataDir: string, ref: RepoRef): string {
  return path.join(dataDir, "state", `${ref.owner}__${ref.repo}.json`);
}

function checkoutDirFor(dataDir: string, ref: RepoRef): string {
  return path.join(dataDir, "repos", ref.owner, ref.repo);
}

function wikiDirFor(dataDir: string, ref: RepoRef): string {
  return path.join(dataDir, "wiki", ref.owner, ref.repo);
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

    if (!opts.skipGenerate) {
      if (!config.llmApiKey) {
        throw new Error("LLM_API_KEY is required to run codewiki generate");
      }
      await mkdir(wikiDir, { recursive: true });
      const result = await codewiki.run(
        {
          homeDir: path.join(config.dataDir, "codewiki-home"),
          llmBaseUrl: config.llmBaseUrl,
          llmApiKey: config.llmApiKey,
          mainModel: config.codewikiModel,
          fallbackModel: config.codewikiFallbackModel,
          maxTokens: config.codewikiMaxTokens,
          exclude: config.codewikiExclude,
          checkoutDir,
          wikiDir,
          hasPreviousOutput,
        },
        log,
      );
      if (!result.ok) {
        throw new Error(`codewiki generate failed for ${repoLabel}`);
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
      for (const id of diff.upsertIds) {
        const doc = documentsById.get(id);
        if (!doc) continue;
        await onyx.upsert(doc);
      }
      for (const id of diff.deleteIds) {
        await onyx.delete(id);
      }
      await saveState(statePath, {
        lastCommit: commit ?? previousState?.lastCommit ?? "",
        pages: currentHashes,
      });
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
  failed: boolean;
}

/** Runs {@link syncOne} for every configured repo (or just `onlyRepo`),
 * never letting one repo's failure abort the rest. */
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

  return { results, failed: results.some((r) => r.status === "failed") };
}
