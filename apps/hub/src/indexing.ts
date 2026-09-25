/**
 * Keeps each tracked repository's slice of the knowledge store in step with
 * its branch: fetch → extract (`indexRepository`) → apply → embed. One run
 * at a time per repository; a push arriving mid-run schedules exactly one
 * follow-up run, so bursts of pushes collapse.
 *
 * Extraction runs in-process against a shallow checkout for now. It is a
 * pure function of the checkout, so moving it into an Atelier sandbox
 * started from the repo's prebuild (research doc §5) changes only
 * `checkout()`/`extract` here, not the stores.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  type ApplyIndexReport,
  applyIndex,
  type DocumentStore,
  type GraphStore,
  indexRepository,
  type KnowledgeDb,
  type KnowledgeSearch,
  newId,
  ORG_PRINCIPAL,
  type RepositoryIndex,
} from "@atelier/knowledge";
import type { RepoConfig } from "./config.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("indexing");

export type IndexRunStatus = "running" | "succeeded" | "failed" | "skipped";

export interface IndexRun {
  id: string;
  repo: string;
  trigger: string;
  status: IndexRunStatus;
  revision?: string;
  report?: ApplyIndexReport;
  warnings: number;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

export interface IndexRunnerDeps {
  db: KnowledgeDb;
  graph: GraphStore;
  documents: DocumentStore;
  search: KnowledgeSearch;
  dataDir: string;
  gitToken?: string;
  /** Overridable for tests (no network). */
  checkout?: (repo: RepoConfig, dir: string) => Promise<string>;
  extract?: (
    input: Parameters<typeof indexRepository>[0],
  ) => Promise<RepositoryIndex>;
}

interface RunRow {
  id: string;
  repo: string;
  trigger: string;
  status: IndexRunStatus;
  revision: string | null;
  report: string | null;
  warnings: number;
  error: string | null;
  started_at: number;
  finished_at: number | null;
}

async function git(args: string[], cwd?: string): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`git ${args[0]} failed: ${err.trim() || `exit ${code}`}`);
  }
  return out.trim();
}

/** Never logged or persisted: the credential only lives in the argv. */
function authedUrl(url: string, token?: string): string {
  if (!token || !url.startsWith("https://")) return url;
  return url.replace("https://", `https://x-access-token:${token}@`);
}

function redact(message: string, token?: string): string {
  return token ? message.replaceAll(token, "***") : message;
}

export class IndexRunner {
  private readonly running = new Map<string, Promise<IndexRun>>();
  private readonly pending = new Map<string, string>();

  constructor(private readonly deps: IndexRunnerDeps) {
    deps.db.run(`CREATE TABLE IF NOT EXISTS hub_index_runs (
      id          TEXT PRIMARY KEY,
      repo        TEXT NOT NULL,
      trigger     TEXT NOT NULL,
      status      TEXT NOT NULL,
      revision    TEXT,
      report      TEXT,
      warnings    INTEGER NOT NULL DEFAULT 0,
      error       TEXT,
      started_at  INTEGER NOT NULL,
      finished_at INTEGER
    )`);
    deps.db.run(
      "CREATE INDEX IF NOT EXISTS hub_index_runs_repo ON hub_index_runs(repo, started_at)",
    );
    // A run cut short by a restart is not coming back.
    deps.db.run(
      "UPDATE hub_index_runs SET status = 'failed', error = 'interrupted' WHERE status = 'running'",
    );
  }

  /**
   * Queues a run. Returns the in-flight run's promise; if one is already
   * running for the repo, the new trigger is folded into one follow-up.
   */
  trigger(repo: RepoConfig, trigger: string, force = false): Promise<IndexRun> {
    const inFlight = this.running.get(repo.repo);
    if (inFlight) {
      this.pending.set(repo.repo, trigger);
      return inFlight;
    }
    const run = this.execute(repo, trigger, force).finally(() => {
      this.running.delete(repo.repo);
      const next = this.pending.get(repo.repo);
      if (next !== undefined) {
        this.pending.delete(repo.repo);
        void this.trigger(repo, next);
      }
    });
    this.running.set(repo.repo, run);
    return run;
  }

  isRunning(repo: string): boolean {
    return this.running.has(repo);
  }

  runs(opts: { repo?: string; limit?: number } = {}): IndexRun[] {
    const rows = this.deps.db
      .query(
        `SELECT * FROM hub_index_runs
         WHERE ($repo IS NULL OR repo = $repo)
         ORDER BY started_at DESC LIMIT $limit`,
      )
      .all({
        repo: opts.repo ?? null,
        limit: Math.min(opts.limit ?? 20, 200),
      }) as RunRow[];
    return rows.map((r) => ({
      id: r.id,
      repo: r.repo,
      trigger: r.trigger,
      status: r.status,
      revision: r.revision ?? undefined,
      report: r.report ? (JSON.parse(r.report) as ApplyIndexReport) : undefined,
      warnings: r.warnings,
      error: r.error ?? undefined,
      startedAt: r.started_at,
      finishedAt: r.finished_at ?? undefined,
    }));
  }

  lastSuccess(repo: string): IndexRun | undefined {
    return this.runs({ repo, limit: 50 }).find((r) => r.status === "succeeded");
  }

  private save(run: IndexRun): void {
    this.deps.db
      .query(
        `INSERT OR REPLACE INTO hub_index_runs
         (id, repo, trigger, status, revision, report, warnings, error,
          started_at, finished_at)
         VALUES ($id, $repo, $trigger, $status, $revision, $report,
          $warnings, $error, $started_at, $finished_at)`,
      )
      .run({
        id: run.id,
        repo: run.repo,
        trigger: run.trigger,
        status: run.status,
        revision: run.revision ?? null,
        report: run.report ? JSON.stringify(run.report) : null,
        warnings: run.warnings,
        error: run.error ?? null,
        started_at: run.startedAt,
        finished_at: run.finishedAt ?? null,
      });
  }

  private async execute(
    repo: RepoConfig,
    trigger: string,
    force: boolean,
  ): Promise<IndexRun> {
    const run: IndexRun = {
      id: newId("run"),
      repo: repo.repo,
      trigger,
      status: "running",
      warnings: 0,
      startedAt: Date.now(),
    };
    this.save(run);
    try {
      const dir = join(this.deps.dataDir, "repos", ...repo.repo.split("/"));
      const checkout = this.deps.checkout ?? ((r, d) => this.checkout(r, d));
      run.revision = await checkout(repo, dir);

      if (!force && this.lastSuccess(repo.repo)?.revision === run.revision) {
        run.status = "skipped";
        return run;
      }

      const extract = this.deps.extract ?? indexRepository;
      const index = await extract({
        root: dir,
        repo: repo.repo,
        revision: run.revision,
        readers: repo.readers ?? [ORG_PRINCIPAL],
        webUrl: `https://github.com/${repo.repo}/blob/${run.revision}`,
        includeFiles: repo.includeFiles,
        includeExternalDeps: repo.includeExternalDeps,
      });
      run.warnings = index.warnings.length;
      run.report = applyIndex(index, {
        graph: this.deps.graph,
        documents: this.deps.documents,
      });
      await this.deps.search.embedPending();
      run.status = "succeeded";
      log.info({ repo: repo.repo, revision: run.revision }, "indexed");
      return run;
    } catch (error) {
      run.status = "failed";
      run.error = redact(
        error instanceof Error ? error.message : String(error),
        this.deps.gitToken,
      );
      log.error({ repo: repo.repo, error: run.error }, "index run failed");
      return run;
    } finally {
      run.finishedAt = Date.now();
      this.save(run);
    }
  }

  /** Shallow fetch of the tracked branch; returns the checked-out sha. */
  private async checkout(repo: RepoConfig, dir: string): Promise<string> {
    const url = authedUrl(
      repo.cloneUrl ?? `https://github.com/${repo.repo}.git`,
      this.deps.gitToken,
    );
    mkdirSync(dir, { recursive: true });
    await git(["init", "--quiet"], dir);
    await git(["fetch", "--quiet", "--depth", "1", url, repo.branch], dir);
    await git(["checkout", "--quiet", "--force", "FETCH_HEAD"], dir);
    await git(["clean", "-qfdx"], dir);
    return git(["rev-parse", "HEAD"], dir);
  }
}
