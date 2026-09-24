import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Search, Sparkles } from "lucide-react";
import { useState } from "react";
import { currentUserQuery } from "@/api/queries/auth";
import {
  type CatalogStarter,
  catalogQuery,
  useLaunchStarter,
  workspacesQuery,
} from "@/api/queries/launchpad";
import { StarterCard } from "@/components/launchpad/starter-card";
import { WorkspaceCard } from "@/components/launchpad/workspace-card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { greeting } from "@/lib/launchpad";

export const Route = createFileRoute("/launchpad/")({
  component: LaunchpadPage,
});

/** How many workspaces "Jump back in" shows before "Show all". */
const RECENT_LIMIT = 6;
/** Offer a search box once the catalog outgrows a glance. */
const SEARCH_THRESHOLD = 6;

function LaunchpadPage() {
  const { data: user } = useQuery(currentUserQuery());
  const navigate = useNavigate();
  const launch = useLaunchStarter();

  function start(starter: CatalogStarter) {
    launch.mutate(
      { starterId: starter.id, request: {} },
      {
        onSuccess: (workspace) => {
          if (!workspace) return;
          navigate({
            to: "/launchpad/w/$workspaceId",
            params: { workspaceId: workspace.id },
            // Opens the name field so it's easy to say what this is for.
            search: { fresh: true },
          });
        },
      },
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-12 px-4 py-10 sm:py-14">
      <section className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {greeting()}
          {user ? `, ${user.username}` : ""}
        </p>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          What are you working on?
        </h1>
        <p className="max-w-2xl text-base text-muted-foreground">
          Pick up where you left off, or start something new. Every workspace
          comes ready to use: nothing to install, nothing to set up.
        </p>
      </section>

      <RecentWorkspaces />

      <StartSomethingNew
        onLaunch={start}
        launchingId={launch.isPending ? launch.variables?.starterId : undefined}
      />
    </div>
  );
}

function RecentWorkspaces() {
  const { data: workspaces, isPending } = useQuery(workspacesQuery());
  const [showAll, setShowAll] = useState(false);

  if (isPending) {
    return (
      <section className="space-y-4">
        <Skeleton className="h-5 w-40" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
      </section>
    );
  }
  if (!workspaces || workspaces.length === 0) return null;

  const visible = showAll ? workspaces : workspaces.slice(0, RECENT_LIMIT);
  return (
    <section className="space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold">Jump back in</h2>
        {workspaces.length > RECENT_LIMIT ? (
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0"
            onClick={() => setShowAll((all) => !all)}
          >
            {showAll ? "Show fewer" : `Show all ${workspaces.length}`}
          </Button>
        ) : null}
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {visible.map((workspace) => (
          <WorkspaceCard key={workspace.id} workspace={workspace} />
        ))}
      </div>
    </section>
  );
}

function StartSomethingNew({
  onLaunch,
  launchingId,
}: {
  onLaunch: (starter: CatalogStarter) => void;
  launchingId: string | undefined;
}) {
  const {
    data: starters,
    isPending,
    isError,
    error,
  } = useQuery(catalogQuery());
  const [search, setSearch] = useState("");

  const needle = search.trim().toLowerCase();
  const filtered = (starters ?? []).filter(
    (s) =>
      !needle ||
      s.title.toLowerCase().includes(needle) ||
      s.description.toLowerCase().includes(needle),
  );

  return (
    <section className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-lg font-semibold">Start something new</h2>
        {(starters?.length ?? 0) > SEARCH_THRESHOLD ? (
          <div className="relative w-full sm:w-72">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search"
              aria-label="Search starters"
              className="pl-9"
            />
          </div>
        ) : null}
      </div>
      {isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
      ) : isError ? (
        <p className="text-sm text-destructive">{error.message}</p>
      ) : !starters || starters.length === 0 ? (
        <EmptyState
          icon={Sparkles}
          title="Nothing to start yet"
          description="Your tech team hasn't prepared anything here yet. Ask them to publish a starter for your team."
          action={
            <Button variant="outline" size="sm" asChild>
              <Link to="/settings/launchpad">I'm on the tech team</Link>
            </Button>
          }
        />
      ) : filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing matches "{search}".
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((starter) => (
            <StarterCard
              key={starter.id}
              starter={starter}
              onLaunch={() => onLaunch(starter)}
              launching={launchingId === starter.id}
              disabled={launchingId !== undefined}
            />
          ))}
        </div>
      )}
    </section>
  );
}
