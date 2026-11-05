import { normalizeBranch, prebuildRepoFor } from "@atelier/spec";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  Hammer,
  RefreshCw,
  Rocket,
  SlidersHorizontal,
} from "lucide-react";
import { type RefObject, useEffect, useRef } from "react";
import { useRunPrebuild } from "@/api/queries/prebuilds";
import { JobStatusBadge } from "@/components/job-status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { RepoCatalogEntry } from "@/hooks/use-repo-catalog";
import {
  formatRelativeTime,
  rebuildTitle,
  repoBranchLabel,
} from "@/lib/formatters";
import { activeJobForBranch, latestBranch } from "@/lib/repo-catalog";
import { RepoIdentity } from "./repo-identity";

/** The list box shows at most this many rows; the rest scroll. A row is
 * ~57px tall on desktop (32px avatar + `py-2.5` + 1px divider). */
const VISIBLE_ROWS = 10;
const ROW_HEIGHT_PX = 57;

/**
 * The repo rows in a fixed-height box (at most `VISIBLE_ROWS` tall) that
 * scrolls on its own, instead of stretching the page. Only the first `limit`
 * rows are mounted; a sentinel after them asks for more as it nears view.
 */
export function RepoScrollList({
  entries,
  limit,
  listRef,
  onLoadMore,
  renderRow,
}: {
  entries: RepoCatalogEntry[];
  limit: number;
  listRef: RefObject<HTMLDivElement | null>;
  onLoadMore: () => void;
  renderRow: (entry: RepoCatalogEntry) => React.ReactNode;
}) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const hasMore = entries.length > limit;
  // Re-armed on every `limit` bump: a fresh observer reports the sentinel's
  // current state, so a sentinel still in range after a load fires again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `limit` re-arms the observer
  useEffect(() => {
    const root = listRef.current;
    const sentinel = sentinelRef.current;
    if (!hasMore || !root || !sentinel) return;
    const observer = new IntersectionObserver(
      (records) => {
        if (records.some((record) => record.isIntersecting)) onLoadMore();
      },
      { root, rootMargin: "0px 0px 400px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, limit, listRef, onLoadMore]);

  return (
    <div
      ref={listRef}
      className="overflow-y-auto rounded-md border"
      style={{ maxHeight: VISIBLE_ROWS * ROW_HEIGHT_PX }}
    >
      <ul className="divide-y" aria-label="Repositories">
        {entries.slice(0, limit).map(renderRow)}
      </ul>
      {hasMore ? <div ref={sentinelRef} aria-hidden className="h-px" /> : null}
    </div>
  );
}

export function RepoRow({
  entry,
  preparing,
  onCreate,
  onCustomize,
}: {
  entry: RepoCatalogEntry;
  preparing: boolean;
  onCreate: () => void;
  onCustomize: () => void;
}) {
  const runPrebuild = useRunPrebuild();
  const { repo, latest, state } = entry;
  // Each button acts on one branch, so it only waits for THAT branch's job:
  // create/retry bakes the default branch, rebuild re-bakes `latest`'s.
  const defaultJob = activeJobForBranch(entry, undefined);
  const branchSuffix = latestBranch(entry);
  const rebuildJob = latest
    ? activeJobForBranch(entry, branchSuffix)
    : undefined;
  const createBusy = preparing || defaultJob !== undefined;

  return (
    <li className="group flex flex-col gap-2 px-3 py-2.5 transition-colors hover:bg-muted/30 sm:flex-row sm:items-center sm:gap-4">
      <RepoIdentity repo={repo} showLink className="flex-1" />
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 sm:w-[330px]">
        <StatusSlot entry={entry} preparing={preparing} />
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label={`Customize a prebuild for ${repo.fullName}`}
          title={
            latest
              ? "Prebuild another branch or change setup steps"
              : "Choose branch, base image and setup steps"
          }
          onClick={onCustomize}
        >
          <SlidersHorizontal />
        </Button>
        {latest ? (
          // Stays spawnable while a rebuild runs: the current bake is fine.
          <>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label={`Rebuild the prebuild for ${repo.fullName}`}
              title={rebuildJob ? "Already rebuilding" : rebuildTitle(latest)}
              disabled={
                rebuildJob !== undefined ||
                runPrebuild.isPending ||
                !latest.spec
              }
              onClick={() => {
                if (latest.spec)
                  runPrebuild.mutate({
                    spec: latest.spec,
                    force: true,
                    label: repoBranchLabel(repo.fullName, branchSuffix),
                  });
              }}
            >
              <RefreshCw
                className={
                  runPrebuild.isPending || rebuildJob ? "animate-spin" : ""
                }
              />
            </Button>
            <Button asChild size="sm" className="w-[132px]">
              <Link
                to="/spawn"
                search={{ repo: repo.fullName, branch: branchSuffix }}
              >
                <Rocket />
                Spawn
              </Link>
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant={state === "failed" ? "outline" : "default"}
            className="w-[132px]"
            loading={preparing}
            disabled={createBusy}
            title={
              defaultJob
                ? "The default branch is already building"
                : "Clone the default branch, install detected dependencies, and snapshot it"
            }
            onClick={onCreate}
          >
            {preparing ? null : state === "failed" ? <RefreshCw /> : <Hammer />}
            {preparing
              ? "Preparing…"
              : defaultJob
                ? "Building…"
                : state === "failed"
                  ? "Retry"
                  : "Create prebuild"}
          </Button>
        )}
      </div>
      {/* Screen readers hear state changes (building → prebuilt) */}
      <span className="sr-only" aria-live="polite">
        {state === "building"
          ? `${repo.fullName}: prebuild building`
          : state === "failed"
            ? `${repo.fullName}: prebuild failed`
            : ""}
      </span>
    </li>
  );
}

/** The status pill left of the actions. Fixed-width slot, so rows don't
 * jitter when a repo flips between states. */
function StatusSlot({
  entry,
  preparing,
}: {
  entry: RepoCatalogEntry;
  preparing: boolean;
}) {
  const { state, latest, activeJob, failedJob, prebuilds } = entry;
  let content: React.ReactNode = null;
  if (activeJob) {
    content = <JobStatusBadge job={activeJob} />;
  } else if (preparing) {
    content = <Badge variant="info">Detecting setup…</Badge>;
  } else if (state === "prebuilt" && latest) {
    // An omitted branch IS the default branch: count them as one.
    const branches = new Set(
      prebuilds.map((p) =>
        normalizeBranch(
          prebuildRepoFor(p, entry.repo.cloneUrl)?.branch,
          entry.repo.defaultBranch,
        ),
      ),
    ).size;
    content = (
      <span className="flex items-center gap-1.5">
        {failedJob ? (
          <Badge
            variant="warning"
            title={`Last rebuild failed: ${failedJob.error ?? "unknown error"}`}
          >
            <AlertTriangle className="mr-1 size-3" />
            Rebuild failed
          </Badge>
        ) : (
          <Badge
            variant="success"
            title={`Built ${new Date(latest.createdAt).toLocaleString()} · ${latest.ref}`}
          >
            Prebuilt {formatRelativeTime(latest.createdAt)}
          </Badge>
        )}
        {branches > 1 ? (
          <span className="text-xs text-muted-foreground">
            {branches} branches
          </span>
        ) : null}
      </span>
    );
  } else if (state === "failed" && failedJob) {
    content = (
      <Badge variant="danger" title={failedJob.error ?? undefined}>
        Failed
      </Badge>
    );
  }
  return (
    <div className="mr-auto flex min-w-0 items-center sm:mr-0">{content}</div>
  );
}
