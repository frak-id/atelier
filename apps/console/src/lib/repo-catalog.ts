/**
 * The repo catalog: each of the user's GitHub repos joined with its stored
 * prebuilds and its prebuild jobs, reduced to one status the UI renders.
 * Pure (no React, no API client) so it is unit-tested directly.
 *
 * Identity comes from `@atelier/spec`'s shared `repoKey`, so a prebuild made
 * from the CLI with an scp URL still matches the https repo GitHub lists.
 */
import {
  findRepoBranchPrebuild,
  findRepoPrebuilds,
  normalizeBranch,
  type PrebuildRecord,
  parsePrebuildJobTarget,
  repoKey,
} from "@atelier/spec";

/** The subset of a job the catalog needs. Structural, so this module stays
 * free of the Eden-derived `Job` type (and of the API client it pulls in). */
export interface CatalogJob {
  id: string;
  kind: string;
  status: "queued" | "running" | "succeeded" | "failed" | "canceled";
  target?: string;
  error?: string | null;
  createdAt: string;
}

/** The subset of a GitHub repo the catalog needs. */
export interface CatalogRepo {
  fullName: string;
  name: string;
  owner: string;
  cloneUrl: string;
  defaultBranch: string;
  description: string | null;
  archived: boolean;
  fork: boolean;
}

type RepoState = "building" | "failed" | "prebuilt" | "none";

export interface CatalogEntry<R extends CatalogRepo, J extends CatalogJob> {
  repo: R;
  state: RepoState;
  /** Every stored prebuild for the repo (any branch), newest first. */
  prebuilds: PrebuildRecord[];
  /** The prebuild a spawn would use: default branch preferred, else the
   * newest on any branch. */
  latest?: PrebuildRecord;
  /** Every in-flight (queued/running) prebuild job for the repo, any
   * branch, newest first. Use `activeJobForBranch` for one branch. */
  activeJobs: J[];
  /** The newest in-flight job on any branch (`activeJobs[0]`), for the
   * repo-level "building" badge. */
  activeJob?: J;
  /** The newest prebuild job, when it failed AND nothing was baked after it.
   * It can coexist with `latest` (a rebuild failed but an older bake exists). */
  failedJob?: J;
}

const ACTIVE = new Set(["queued", "running"]);

/** Join repos × prebuilds × jobs. Repo order is preserved (GitHub's
 * most-recently-pushed order); `jobs` and `prebuilds` are newest-first, as
 * the API returns them. */
export function buildRepoCatalog<R extends CatalogRepo, J extends CatalogJob>(
  repos: readonly R[],
  prebuilds: readonly PrebuildRecord[],
  jobs: readonly J[],
): CatalogEntry<R, J>[] {
  // Index prebuild jobs by repo key once: O(jobs) rather than O(repos × jobs).
  const jobsByRepo = new Map<string, J[]>();
  for (const job of jobs) {
    if (job.kind !== "prebuild") continue;
    const keys = parsePrebuildJobTarget(job.target).map((t) => t.key);
    for (const key of new Set(keys)) {
      const list = jobsByRepo.get(key);
      if (list) list.push(job);
      else jobsByRepo.set(key, [job]);
    }
  }

  return repos.map((repo) => {
    const repoPrebuilds = findRepoPrebuilds(prebuilds, repo.cloneUrl);
    const latest =
      findRepoBranchPrebuild(
        repoPrebuilds,
        repo.cloneUrl,
        undefined,
        repo.defaultBranch,
      ) ?? repoPrebuilds[0];
    const repoJobs = jobsByRepo.get(repoKey(repo.cloneUrl)) ?? [];
    const activeJobs = repoJobs.filter((j) => ACTIVE.has(j.status));
    const activeJob = activeJobs[0];
    const newest = repoJobs[0];
    const failedJob =
      newest?.status === "failed" &&
      (!latest || newest.createdAt > latest.createdAt)
        ? newest
        : undefined;
    const state: RepoState = activeJob
      ? "building"
      : latest
        ? "prebuilt"
        : failedJob
          ? "failed"
          : "none";
    return {
      repo,
      state,
      prebuilds: repoPrebuilds,
      latest,
      activeJobs,
      activeJob,
      failedJob,
    };
  });
}

/** The in-flight prebuild job baking `branch` of the entry's repo, if any.
 * Matches on the parsed job target (repo identity + normalized branch), so
 * `main` vs omitted and https vs scp spellings still line up. */
export function activeJobForBranch<J extends CatalogJob>(
  entry: Pick<CatalogEntry<CatalogRepo, J>, "repo" | "activeJobs">,
  branch: string | undefined,
): J | undefined {
  const { cloneUrl, defaultBranch } = entry.repo;
  const key = repoKey(cloneUrl);
  const want = normalizeBranch(branch, defaultBranch);
  return entry.activeJobs.find((job) =>
    parsePrebuildJobTarget(job.target).some(
      (t) => t.key === key && normalizeBranch(t.branch, defaultBranch) === want,
    ),
  );
}

export type CatalogFilter = "all" | "needs" | "prebuilt";

/** "Needs a prebuild" = nothing baked yet (including failed attempts and
 * in-flight first bakes, which leave the list when they succeed). */
function needsPrebuild(entry: { latest?: unknown }): boolean {
  return entry.latest === undefined;
}

/** Search + filter the catalog. `showHidden` includes archived repos and
 * forks, which are hidden by default as noise for a "what do I work on" list. */
export function filterCatalog<E extends CatalogEntry<CatalogRepo, CatalogJob>>(
  entries: readonly E[],
  options: { query: string; filter: CatalogFilter; showHidden: boolean },
): E[] {
  const terms = options.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter((entry) => {
    const { repo } = entry;
    if (!options.showHidden && (repo.archived || repo.fork)) return false;
    if (options.filter === "needs" && !needsPrebuild(entry)) return false;
    if (options.filter === "prebuilt" && needsPrebuild(entry)) return false;
    if (terms.length === 0) return true;
    const haystack = `${repo.fullName} ${repo.description ?? ""}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

/** Per-filter counts over the visibility-filtered (not search-filtered)
 * catalog, for the segmented control's labels. */
export function catalogCounts(
  entries: readonly CatalogEntry<CatalogRepo, CatalogJob>[],
  showHidden: boolean,
): Record<CatalogFilter, number> {
  const visible = entries.filter(
    (e) => showHidden || !(e.repo.archived || e.repo.fork),
  );
  const prebuilt = visible.filter((e) => !needsPrebuild(e)).length;
  return {
    all: visible.length,
    prebuilt,
    needs: visible.length - prebuilt,
  };
}
