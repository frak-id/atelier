import {
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  Search,
  SearchX,
} from "lucide-react";
import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRefreshGithubRepos } from "@/api/queries/github";
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
import { NativeSelect } from "@/components/ui/native-select";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type RepoCatalogEntry,
  useQuickPrebuild,
  useRepoCatalog,
} from "@/hooks/use-repo-catalog";
import {
  type CatalogFilter,
  catalogCounts,
  catalogOwners,
  filterCatalog,
} from "@/lib/repo-catalog";
import { QuickPrebuildDialog } from "./quick-prebuild-dialog";
import { RepoRow, RepoScrollList } from "./repo-catalog-list";

/** Rows rendered per step; more mount as the list is scrolled near its end,
 * so a 500-repo account doesn't mount 500 rows up front. */
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
  // GitHub owner (the user's account or an org) to narrow to; "" = all.
  const [owner, setOwner] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [customizing, setCustomizing] = useState<string | undefined>();
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const loadMore = useCallback(() => setLimit((n) => n + PAGE_SIZE), []);

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
    () => filterCatalog(catalog.entries, { query, filter, showHidden, owner }),
    [catalog.entries, query, filter, showHidden, owner],
  );
  const counts = useMemo(
    () => catalogCounts(catalog.entries, { showHidden, owner }),
    [catalog.entries, showHidden, owner],
  );
  const owners = useMemo(
    () => catalogOwners(catalog.entries, { showHidden, selected: owner }),
    [catalog.entries, showHidden, owner],
  );
  // Resolve the dialog's entry from the live catalog so its status (e.g. a
  // job that just started elsewhere) stays current while it is open.
  const customizeEntry = catalog.entries.find(
    (e) => e.repo.fullName === customizing,
  );

  // A new result set starts back at the top of the list box.
  function resetPaging() {
    setLimit(PAGE_SIZE);
    listRef.current?.scrollTo({ top: 0 });
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
            {owners.length > 1 || owner ? (
              <div className="sm:w-48">
                <NativeSelect
                  value={owner}
                  onChange={(e) => {
                    setOwner(e.target.value);
                    resetPaging();
                  }}
                  aria-label="Filter by organization"
                >
                  <option value="">All organizations</option>
                  {owners.map((o) => (
                    <option key={o.owner} value={o.owner}>
                      {o.owner} ({o.count})
                    </option>
                  ))}
                </NativeSelect>
              </div>
            ) : null}
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
          listRef={listRef}
          onLoadMore={loadMore}
          query={query}
          filter={filter}
          owner={owner}
          onClearSearch={() => {
            setQuery("");
            setFilter("all");
            setOwner("");
            resetPaging();
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
            <span>
              {visible.length}{" "}
              {visible.length === 1 ? "repository" : "repositories"}
              {catalog.truncated
                ? " · from your 500 most recently pushed"
                : null}
            </span>
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
  listRef,
  onLoadMore,
  query,
  filter,
  owner,
  onClearSearch,
  renderRow,
}: {
  catalog: ReturnType<typeof useRepoCatalog>;
  visible: RepoCatalogEntry[];
  limit: number;
  listRef: RefObject<HTMLDivElement | null>;
  onLoadMore: () => void;
  query: string;
  filter: CatalogFilter;
  owner: string;
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
        description="There's no GitHub token to list your repositories. On a hosted Atelier, sign out and sign back in with GitHub. In local mode, start the server with ATELIER_GITHUB_TOKEN set (e.g. `GITHUB_TOKEN=$(gh auth token) docker compose -f docker-compose.local.yml up`). You can still create a prebuild for any URL with “New prebuild”."
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
    const everyPrebuilt = filter === "needs" && !query.trim() && !owner;
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
    <RepoScrollList
      entries={visible}
      limit={limit}
      listRef={listRef}
      onLoadMore={onLoadMore}
      renderRow={renderRow}
    />
  );
}
