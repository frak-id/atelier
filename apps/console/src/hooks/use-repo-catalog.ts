import { buildRepoPrebuildSpec } from "@atelier/spec";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  type GitHubRepo,
  githubRepoInspectQuery,
  githubReposQuery,
} from "@/api/queries/github";
import { type Job, jobsListQuery } from "@/api/queries/jobs";
import { prebuildsListQuery, useRunPrebuild } from "@/api/queries/prebuilds";
import { serverConfigQuery } from "@/api/queries/server-config";
import {
  activeJobForBranch,
  buildRepoCatalog,
  type CatalogEntry,
} from "@/lib/repo-catalog";

export type RepoCatalogEntry = CatalogEntry<GitHubRepo, Job>;

/** Base image a quick prebuild boots from: the server's
 * `sandbox.defaultImage` config, falling back to the stock `dev-base`. */
export function useDefaultImage(): string {
  const { data } = useQuery(serverConfigQuery());
  const entry = data?.find((e) => e.key === "sandbox.defaultImage");
  return typeof entry?.value === "string" && entry.value.trim()
    ? entry.value
    : "dev-base";
}

/**
 * The user's GitHub repos joined with stored prebuilds and prebuild jobs.
 * Stays live without polling: the jobs cache is SSE-fed, and a finished bake
 * invalidates the prebuilds list (`useJobEvents`).
 */
export function useRepoCatalog() {
  const repos = useQuery(githubReposQuery());
  const prebuilds = useQuery(prebuildsListQuery());
  const jobs = useQuery(jobsListQuery());

  const entries = useMemo<RepoCatalogEntry[]>(
    () =>
      buildRepoCatalog(
        repos.data?.repos ?? [],
        prebuilds.data ?? [],
        jobs.data ?? [],
      ),
    [repos.data, prebuilds.data, jobs.data],
  );

  return {
    entries,
    connected: repos.data?.connected ?? true,
    truncated: repos.data?.truncated ?? false,
    // Prebuilds are needed to know each repo's status; without them every
    // repo would briefly flash "Create prebuild".
    isPending: repos.isPending || prebuilds.isPending,
    error: repos.error ?? prebuilds.error,
    refetch: () => {
      repos.refetch();
      prebuilds.refetch();
    },
  };
}

/**
 * What a branch picker + setup-step preview need for one repo: the branch
 * list (from the default-branch inspection, which is fetched once and
 * shared) and the setup steps detected on `branch` (`undefined` = default).
 * Both inspections are cached per repo+branch, so switching back and forth
 * is instant.
 */
export function useRepoInspection(
  repo: GitHubRepo,
  branch: string | undefined,
  options: { enabled?: boolean } = {},
) {
  const enabled = options.enabled ?? true;
  const base = useQuery(githubRepoInspectQuery(repo.owner, repo.name));
  const atBranch = useQuery({
    ...githubRepoInspectQuery(repo.owner, repo.name, branch),
    enabled,
  });
  return {
    branches: base.data?.branches ?? [repo.defaultBranch],
    suggestedBuild: atBranch.data?.suggestedBuild,
    /** No answer for this branch yet. A failed inspection is NOT
     * detecting: it just means "no steps" and must never block a submit. */
    detecting: enabled && atBranch.isPending,
  };
}

/**
 * The one-click path: inspect the repo (default branch + detected setup
 * steps), assemble the spec with the shared `buildRepoPrebuildSpec`, and
 * dispatch the bake. It returns a per-repo pending set, so every row owns
 * its own spinner and a double click can't dispatch twice.
 */
export function useQuickPrebuild() {
  const queryClient = useQueryClient();
  const { mutateAsync: runPrebuild } = useRunPrebuild();
  const defaultImage = useDefaultImage();
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  // The synchronous guard: state only updates on the next render, so two
  // clicks in the same frame would both pass a state-based check.
  const inflight = useRef(new Set<string>());

  const create = useCallback(
    async (entry: RepoCatalogEntry) => {
      const { repo } = entry;
      // One-click always bakes the default branch.
      if (
        activeJobForBranch(entry, undefined) ||
        inflight.current.has(repo.fullName)
      )
        return;
      inflight.current.add(repo.fullName);
      setPending((prev) => new Set(prev).add(repo.fullName));
      try {
        const inspection = await queryClient
          .fetchQuery(githubRepoInspectQuery(repo.owner, repo.name))
          .catch((err: unknown) => {
            // Detection is a nicety. If GitHub can't be read, still bake
            // the bare clone and let the user add steps later.
            toast.warning(`Couldn't detect setup steps for ${repo.fullName}`, {
              description: err instanceof Error ? err.message : undefined,
            });
            return undefined;
          });
        const spec = buildRepoPrebuildSpec({
          repo: repo.cloneUrl,
          image: defaultImage,
          build: inspection?.suggestedBuild,
        });
        await runPrebuild({ spec, label: repo.fullName });
      } catch {
        // The mutation's onError already toasted.
      } finally {
        inflight.current.delete(repo.fullName);
        setPending((prev) => {
          const next = new Set(prev);
          next.delete(repo.fullName);
          return next;
        });
      }
    },
    [queryClient, runPrebuild, defaultImage],
  );

  return { create, pending };
}
