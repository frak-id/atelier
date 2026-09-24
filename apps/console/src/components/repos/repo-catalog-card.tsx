import { normalizeBranch, prebuildRepoFor } from "@atelier/spec";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  CheckCircle2,
  Hammer,
  RefreshCw,
  Rocket,
  Search,
  SearchX,
  SlidersHorizontal,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRefreshGithubRepos } from "@/api/queries/github";
import { useRunPrebuild } from "@/api/queries/prebuilds";
import { JobStatusBadge } from "@/components/job-status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/ui/empty-state";
import { GithubIcon } from "@/components/ui/github-icon";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type RepoCatalogEntry,
  useQuickPrebuild,
  useRepoCatalog,
} from "@/hooks/use-repo-catalog";
import {
  formatRelativeTime,
  rebuildTitle,
  repoBranchLabel,
} from "@/lib/formatters";
import {
  activeJobForBranch,
  type CatalogFilter,
  catalogCounts,
  filterCatalog,
} from "@/lib/repo-catalog";
import { QuickPrebuildDialog } from "./quick-prebuild-dialog";
import { RepoIdentity } from "./repo-identity";

const PAGE_SIZE = 50;

/**
 * "Your repositories": every GitHub repo the user can access, with its
 * prebuild status and a one-click "Create prebuild" for those without one.
 * The headline of the Prebuilds tab.
 */
export function RepoCatalogCard() {
  const catalog = useRepoCatalog();
  const refresh = useRefreshGithubRepos();
  const quick = useQuickPrebuild();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<CatalogFilter>("all");
  const [showHidden, setShowHidden] = useState(false);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [customizing, setCustomizing] = useState<string | undefined>();
  const searchRef = useRef<HTMLInputElement>(null);

  // "/" focuses the search box (unless the user is already typing somewhere).
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "/" || event.metaKey || event.ctrlKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.closest("input, textarea, select, [contenteditable=true]") ||
        document.querySelector("[role=dialog]")
      )
        return;
      event.preventDefault();
      searchRef.current?.focus();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const visible = useMemo(
    () => filterCatalog(catalog.entries, { query, filter, showHidden }),
    [catalog.entries, query, filter, showHidden],
  );
  const counts = useMemo(
    () => catalogCounts(catalog.entries, showHidden),
    [catalog.entries, showHidden],
  );
  // Resolve the dialog's entry from the live catalog so its status (e.g. a
  // job that just started elsewhere) stays current while it is open.
  const customizeEntry = catalog.entries.find(
    (e) => e.repo.fullName === customizing,
  );

  function resetPaging() {
    setLimit(PAGE_SIZE);
  }

  return (
    <Card>
      <CardHeader className="gap-3 space-y-0">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2">
              <GithubIcon className="size-4" />
              Your repositories
            </CardTitle>
            <CardDescription>
              Prebuild a repo once and every sandbox of it boots with the code
              cloned and dependencies installed.
            </CardDescription>
          </div>
          {catalog.connected ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Refresh repositories from GitHub"
              title="Refresh from GitHub"
              disabled={refresh.isPending || catalog.isPending}
              onClick={() => refresh.mutate()}
            >
              <RefreshCw className={refresh.isPending ? "animate-spin" : ""} />
            </Button>
          ) : null}
        </div>
        {catalog.connected && !catalog.error ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={searchRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  resetPaging();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setQuery("");
                }}
                placeholder="Search repositories"
                aria-label="Search repositories"
                className="pr-8 pl-8"
              />
              <kbd className="pointer-events-none absolute top-1/2 right-2.5 hidden -translate-y-1/2 rounded border bg-muted px-1.5 font-mono text-[10px] text-muted-foreground sm:block">
                /
              </kbd>
            </div>
            <SegmentedControl
              options={[
                { value: "all", label: `All ${counts.all}` },
                { value: "needs", label: `Needs prebuild ${counts.needs}` },
                { value: "prebuilt", label: `Prebuilt ${counts.prebuilt}` },
              ]}
              value={filter}
              onChange={(next) => {
                setFilter(next);
                resetPaging();
              }}
              className="self-start sm:self-auto"
            />
          </div>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-2">
        <CatalogBody
          catalog={catalog}
          visible={visible}
          limit={limit}
          query={query}
          filter={filter}
          onClearSearch={() => {
            setQuery("");
            setFilter("all");
          }}
          renderRow={(entry) => (
            <RepoRow
              key={entry.repo.fullName}
              entry={entry}
              preparing={quick.pending.has(entry.repo.fullName)}
              onCreate={() => quick.create(entry)}
              onCustomize={() => setCustomizing(entry.repo.fullName)}
            />
          )}
        />
        {catalog.connected && !catalog.error && !catalog.isPending ? (
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs text-muted-foreground">
            <label
              htmlFor="repo-catalog-show-hidden"
              className="flex cursor-pointer items-center gap-2"
            >
              <Checkbox
                id="repo-catalog-show-hidden"
                checked={showHidden}
                onChange={(e) => {
                  setShowHidden(e.target.checked);
                  resetPaging();
                }}
              />
              Show archived repos and forks
            </label>
            <div className="flex items-center gap-3">
              {catalog.truncated ? (
                <span>Showing your 500 most recently pushed repos</span>
              ) : null}
              {visible.length > limit ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setLimit((n) => n + PAGE_SIZE)}
                >
                  Show {Math.min(PAGE_SIZE, visible.length - limit)} more
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </CardContent>
      <QuickPrebuildDialog
        repoName={customizing}
        entry={customizeEntry}
        onOpenChange={(open) => {
          if (!open) setCustomizing(undefined);
        }}
      />
    </Card>
  );
}

function CatalogBody({
  catalog,
  visible,
  limit,
  query,
  filter,
  onClearSearch,
  renderRow,
}: {
  catalog: ReturnType<typeof useRepoCatalog>;
  visible: RepoCatalogEntry[];
  limit: number;
  query: string;
  filter: CatalogFilter;
  onClearSearch: () => void;
  renderRow: (entry: RepoCatalogEntry) => React.ReactNode;
}) {
  if (catalog.isPending) {
    return (
      <div
        className="space-y-2"
        role="status"
        aria-busy="true"
        aria-label="Loading repositories"
      >
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[58px] w-full" />
        ))}
      </div>
    );
  }
  if (catalog.error) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Couldn't load your repositories"
        description={catalog.error.message}
        action={
          <Button variant="outline" size="sm" onClick={catalog.refetch}>
            <RefreshCw />
            Try again
          </Button>
        }
      />
    );
  }
  if (!catalog.connected) {
    return (
      <EmptyState
        icon={GithubIcon}
        title="GitHub isn't connected for your account"
        description="There's no GitHub token to list your repositories. On a hosted Atelier, sign out and sign back in with GitHub. In local mode, start the server with ATELIER_GITHUB_TOKEN set (or log in with `gh auth login` before `atelier local up`). You can still create a prebuild for any URL with “New prebuild”."
      />
    );
  }
  if (catalog.entries.length === 0) {
    return (
      <EmptyState
        icon={GithubIcon}
        title="No repositories yet"
        description="Your GitHub account doesn't have access to any repositories."
      />
    );
  }
  if (visible.length === 0) {
    const everyPrebuilt = filter === "needs" && !query.trim();
    return (
      <EmptyState
        icon={everyPrebuilt ? CheckCircle2 : SearchX}
        title={
          everyPrebuilt
            ? "Every repository has a prebuild"
            : "No repositories match"
        }
        description={
          everyPrebuilt
            ? "New repos you get access to will show up here."
            : "Try a different search or filter."
        }
        action={
          everyPrebuilt ? undefined : (
            <Button variant="outline" size="sm" onClick={onClearSearch}>
              Clear search
            </Button>
          )
        }
      />
    );
  }
  return (
    <ul className="divide-y rounded-md border">
      {visible.slice(0, limit).map(renderRow)}
    </ul>
  );
}

function RepoRow({
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
  // The branch THIS repo is cloned at in `latest`, which may be a multi-repo
  // prebuild where it isn't the first repo.
  const latestBranch = latest
    ? prebuildRepoFor(latest, repo.cloneUrl)?.branch
    : undefined;
  const rebuildJob = latest
    ? activeJobForBranch(entry, latestBranch)
    : undefined;
  const createBusy = preparing || defaultJob !== undefined;
  const branchSuffix = normalizeBranch(latestBranch, repo.defaultBranch);

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
