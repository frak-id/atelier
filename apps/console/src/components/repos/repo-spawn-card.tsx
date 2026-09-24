import {
  buildRepoPrebuildSpec,
  type CreateSandboxRequest,
  findRepoBranchPrebuild,
  type SandboxSpec,
} from "@atelier/spec";
import { useQuery } from "@tanstack/react-query";
import { Hammer, Loader2, Rocket, Search, Timer, X, Zap } from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";
import { githubRepoInspectQuery } from "@/api/queries/github";
import { useRunPrebuild } from "@/api/queries/prebuilds";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { GithubIcon } from "@/components/ui/github-icon";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type RepoCatalogEntry,
  useDefaultImage,
  useRepoCatalog,
} from "@/hooks/use-repo-catalog";
import { formatRelativeTime } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import { RepoIdentity } from "./repo-identity";

const PICKER_LIMIT = 50;

/**
 * "Spawn from a repository": pick one of your GitHub repos + a branch and
 * spawn. With a prebuild for that branch the sandbox boots from the snapshot
 * right away. Without one, the request carries the prebuild *recipe*: the
 * server bakes it (the same spec the Prebuilds tab would create) and boots
 * from it, so the first spawn is slower and later ones are instant.
 *
 * Controlled by the page's URL search params (`?repo=&branch=`), so the
 * selection is deep-linkable, e.g. from the Prebuilds tab's "Spawn" button.
 */
export function RepoSpawnCard({
  repo: selectedName,
  branch: selectedBranch,
  onSelectionChange,
  baseSpec,
  onSpawn,
  spawnPending,
}: {
  repo?: string;
  branch?: string;
  onSelectionChange: (next: { repo?: string; branch?: string }) => void;
  /** Resources etc. from the page's shared spawn options. */
  baseSpec: (image: string) => SandboxSpec;
  onSpawn: (request: CreateSandboxRequest) => void;
  spawnPending: boolean;
}) {
  const catalog = useRepoCatalog();
  const entry = selectedName
    ? catalog.entries.find(
        (e) => e.repo.fullName.toLowerCase() === selectedName.toLowerCase(),
      )
    : undefined;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <GithubIcon className="size-4" />
          Spawn from a repository
        </CardTitle>
        <CardDescription>
          Pick a repo and branch. Prebuilt repos boot instantly; the others get
          prebuilt on their first spawn.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {catalog.isPending ? (
          <div className="space-y-2">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : catalog.error ? (
          <p className="text-sm text-destructive">{catalog.error.message}</p>
        ) : !catalog.connected ? (
          <p className="text-sm text-muted-foreground">
            GitHub isn't connected for your account, so your repositories can't
            be listed. You can still spawn from a stored prebuild below.
          </p>
        ) : entry ? (
          <SelectedRepo
            entry={entry}
            branch={selectedBranch}
            onBranchChange={(branch) =>
              onSelectionChange({ repo: entry.repo.fullName, branch })
            }
            onClear={() => onSelectionChange({})}
            baseSpec={baseSpec}
            onSpawn={onSpawn}
            spawnPending={spawnPending}
          />
        ) : (
          <>
            {selectedName ? (
              <p className="mb-2 text-sm text-warning">
                <span className="font-mono">{selectedName}</span> isn't among
                your GitHub repositories. Pick another one:
              </p>
            ) : null}
            <RepoPicker
              entries={catalog.entries}
              onSelect={(e) => onSelectionChange({ repo: e.repo.fullName })}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** Search box + keyboard-navigable list (↑/↓, Enter). Prebuilt repos first,
 * then by last push; archived repos only show when searched for. */
function RepoPicker({
  entries,
  onSelect,
}: {
  entries: RepoCatalogEntry[];
  onSelect: (entry: RepoCatalogEntry) => void;
}) {
  const listId = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const filtered = entries.filter((e) => {
      if (terms.length === 0) return !e.repo.archived;
      const hay =
        `${e.repo.fullName} ${e.repo.description ?? ""}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
    // Stable sort keeps GitHub's most-recently-pushed order within groups.
    return filtered
      .map((e, i) => ({ e, i }))
      .sort(
        (a, b) =>
          Number(b.e.latest !== undefined) - Number(a.e.latest !== undefined) ||
          a.i - b.i,
      )
      .map(({ e }) => e)
      .slice(0, PICKER_LIMIT);
  }, [entries, query]);

  const clamped = Math.min(active, Math.max(0, matches.length - 1));

  function move(delta: number) {
    if (matches.length === 0) return;
    const next = (clamped + delta + matches.length) % matches.length;
    setActive(next);
    listRef.current
      ?.querySelector(`[data-index="${next}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={
            matches[clamped] ? `${listId}-${clamped}` : undefined
          }
          aria-label="Search your repositories"
          placeholder="Search your repositories"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              move(1);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              move(-1);
            } else if (e.key === "Enter") {
              e.preventDefault();
              const pick = matches[clamped];
              if (pick) onSelect(pick);
            } else if (e.key === "Escape") {
              setQuery("");
            }
          }}
          className="pl-8"
        />
      </div>
      {matches.length === 0 ? (
        <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
          No repositories match “{query}”.
        </p>
      ) : (
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Repositories"
          className="max-h-72 divide-y overflow-y-auto rounded-md border"
        >
          {matches.map((entry, index) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard is handled by the combobox input (↑/↓/Enter)
            <div
              key={entry.repo.fullName}
              id={`${listId}-${index}`}
              data-index={index}
              role="option"
              tabIndex={-1}
              aria-selected={index === clamped}
              onMouseEnter={() => setActive(index)}
              onClick={() => onSelect(entry)}
              className={cn(
                "flex cursor-pointer items-center gap-3 px-3 py-2",
                index === clamped && "bg-muted/60",
              )}
            >
              <RepoIdentity repo={entry.repo} className="flex-1" />
              {entry.latest ? (
                <Badge variant="success" className="shrink-0">
                  <Zap className="mr-1 size-3" />
                  Prebuilt
                </Badge>
              ) : entry.activeJob ? (
                <Badge variant="info" className="shrink-0">
                  Building
                </Badge>
              ) : (
                <span className="shrink-0 text-xs text-muted-foreground">
                  No prebuild
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SelectedRepo({
  entry,
  branch: branchParamIn,
  onBranchChange,
  onClear,
  baseSpec,
  onSpawn,
  spawnPending,
}: {
  entry: RepoCatalogEntry;
  branch?: string;
  onBranchChange: (branch: string | undefined) => void;
  onClear: () => void;
  baseSpec: (image: string) => SandboxSpec;
  onSpawn: (request: CreateSandboxRequest) => void;
  spawnPending: boolean;
}) {
  const { repo } = entry;
  const ids = useId();
  const defaultImage = useDefaultImage();
  const runPrebuild = useRunPrebuild();

  const branch = branchParamIn?.trim() || repo.defaultBranch;
  // The default branch is spelled "no branch" in specs, so a spawn and the
  // Prebuilds tab's one-click create produce the same recipe (same hash).
  const branchParam = branch === repo.defaultBranch ? undefined : branch;

  const base = useQuery(githubRepoInspectQuery(repo.owner, repo.name));
  const atBranch = useQuery(
    githubRepoInspectQuery(repo.owner, repo.name, branchParam),
  );
  const branches = useMemo(() => {
    const list = base.data?.branches ?? [repo.defaultBranch];
    // Keep a deep-linked branch selectable even beyond the listed 100.
    return list.includes(branch) ? list : [...list, branch];
  }, [base.data, repo.defaultBranch, branch]);

  const matched = findRepoBranchPrebuild(
    entry.prebuilds,
    repo.cloneUrl,
    branchParam,
    repo.defaultBranch,
  );
  const buildingThis =
    entry.activeJob?.target ===
    (branchParam ? `${repo.cloneUrl}#${branchParam}` : repo.cloneUrl);
  // The recipe path needs the detected steps; a failed inspection just
  // means "no steps" and must not block the spawn.
  const stepsReady = !atBranch.isPending;
  const recipe = () =>
    buildRepoPrebuildSpec({
      repo: repo.cloneUrl,
      branch: branchParam,
      image: defaultImage,
      build: atBranch.data?.suggestedBuild,
    });
  const metadata = {
    name: repo.name,
    repo: repo.fullName,
    ...(branchParam ? { branch: branchParam } : {}),
  };

  function spawn() {
    if (matched) {
      onSpawn({
        ...baseSpec(defaultImage),
        source: { snapshot: matched.ref },
        metadata,
      });
    } else {
      onSpawn({ ...baseSpec(defaultImage), prebuild: recipe(), metadata });
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 rounded-md border bg-muted/20 p-3">
        <RepoIdentity repo={repo} showLink className="group flex-1" />
        <Button
          variant="ghost"
          size="sm"
          onClick={onClear}
          aria-label="Choose a different repository"
        >
          <X />
          Change
        </Button>
      </div>

      <div className="space-y-1 sm:max-w-xs">
        <Label htmlFor={`${ids}-branch`}>Branch</Label>
        <NativeSelect
          id={`${ids}-branch`}
          value={branch}
          onChange={(e) =>
            onBranchChange(
              e.target.value === repo.defaultBranch
                ? undefined
                : e.target.value,
            )
          }
        >
          {branches.map((b) => (
            <option key={b} value={b}>
              {b === repo.defaultBranch ? `${b} (default)` : b}
            </option>
          ))}
        </NativeSelect>
      </div>

      <SpawnPlan
        matchedAt={matched?.createdAt}
        building={buildingThis}
        steps={atBranch.data?.suggestedBuild}
        stepsPending={!stepsReady}
      />

      <div className="flex flex-wrap gap-2">
        <Button
          disabled={spawnPending || (!matched && !stepsReady)}
          loading={spawnPending}
          onClick={spawn}
        >
          {spawnPending ? null : <Rocket />}
          {matched ? "Spawn" : "Prebuild & spawn"}
        </Button>
        {!matched ? (
          <Button
            variant="outline"
            disabled={runPrebuild.isPending || buildingThis || !stepsReady}
            loading={runPrebuild.isPending}
            title="Bake the prebuild now and spawn later"
            onClick={() =>
              runPrebuild.mutate({
                spec: recipe(),
                label: branchParam
                  ? `${repo.fullName}#${branchParam}`
                  : repo.fullName,
              })
            }
          >
            {runPrebuild.isPending ? null : <Hammer />}
            Prebuild only
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** One line telling the user what "Spawn" is about to do and how long it
 * will roughly take. */
function SpawnPlan({
  matchedAt,
  building,
  steps,
  stepsPending,
}: {
  matchedAt?: string;
  building: boolean;
  steps?: string[];
  stepsPending: boolean;
}) {
  if (matchedAt) {
    return (
      <p className="flex items-start gap-2 rounded-md border border-success/30 bg-success/10 p-2.5 text-sm text-success">
        <Zap className="mt-0.5 size-4 shrink-0" />
        Boots instantly from the prebuild built {formatRelativeTime(matchedAt)}.
      </p>
    );
  }
  if (building) {
    return (
      <p className="flex items-start gap-2 rounded-md border border-info/30 bg-info/10 p-2.5 text-sm text-info">
        <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" />A prebuild
        for this branch is building. Spawning now waits for it to finish.
      </p>
    );
  }
  return (
    <div className="flex items-start gap-2 rounded-md border bg-muted/30 p-2.5 text-sm text-muted-foreground">
      <Timer className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 space-y-1">
        <p>
          No prebuild for this branch yet. The first spawn clones and sets it up
          (slower); later spawns boot instantly.
        </p>
        <p className="truncate font-mono text-xs">
          {stepsPending
            ? "Detecting setup steps…"
            : steps && steps.length > 0
              ? `Setup: ${steps.join(" && ")}`
              : "Setup: clone only (no install steps detected)"}
        </p>
      </div>
    </div>
  );
}
