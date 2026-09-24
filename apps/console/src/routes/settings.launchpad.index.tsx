import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ExternalLink, Pencil, Plus, Sparkles, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  type StarterRecord,
  startersQuery,
  useDeleteStarter,
} from "@/api/queries/launchpad";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { OwnerScopeSelect } from "@/components/owner-scope-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRelativeTime } from "@/lib/formatters";
import { LaunchpadIconView } from "@/lib/launchpad";

export const Route = createFileRoute("/settings/launchpad/")({
  component: LaunchpadSettingsPage,
});

function LaunchpadSettingsPage() {
  const [owner, setOwner] = useState("user");
  const {
    data: starters,
    isPending,
    isError,
    error,
  } = useQuery(startersQuery(owner));

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Starters are what non-technical teammates see on the{" "}
        <Link to="/launchpad" className="underline">
          Launchpad
        </Link>
        : a friendly card that boots a prepared workspace (a prebuild,
        toolboxes, context) and opens the tools you choose. Org starters are
        visible to every member of the org.
      </p>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="w-full space-y-1 sm:max-w-xs">
          <OwnerScopeSelect
            id="starter-scope"
            personalLabel="My starters"
            value={owner}
            onChange={setOwner}
          />
        </div>
        <Button size="sm" asChild>
          <Link to="/settings/launchpad/new" search={{ owner }}>
            <Plus />
            New starter
          </Link>
        </Button>
      </div>
      {isPending ? (
        <Skeleton className="h-20 w-full" />
      ) : isError ? (
        <p className="text-sm text-destructive">{error.message}</p>
      ) : starters.length === 0 ? (
        <EmptyState
          icon={Sparkles}
          title="No starters in this scope"
          description="Prepare one: pick a prebuild, the toolboxes it needs, and the tools to open."
          action={
            <Button size="sm" asChild>
              <Link to="/settings/launchpad/new" search={{ owner }}>
                <Plus />
                New starter
              </Link>
            </Button>
          }
        />
      ) : (
        <div className="space-y-2">
          {starters.map((starter) => (
            <StarterRow key={starter.id} starter={starter} owner={owner} />
          ))}
        </div>
      )}
    </div>
  );
}

function bootLabel(starter: StarterRecord): string {
  const { recipe } = starter;
  if (recipe.prebuild) {
    const repo = recipe.prebuild.repos?.[0]?.url;
    return repo ? `prebuild · ${repo}` : "prebuild";
  }
  return "image" in recipe.source
    ? `image · ${recipe.source.image}`
    : `snapshot · ${recipe.source.snapshot}`;
}

function StarterRow({
  starter,
  owner,
}: {
  starter: StarterRecord;
  owner: string;
}) {
  const remove = useDeleteStarter();
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
          <LaunchpadIconView icon={starter.icon} />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{starter.title}</span>
            {starter.published ? (
              <Badge variant="success">published</Badge>
            ) : (
              <Badge variant="neutral">draft</Badge>
            )}
            <span className="text-xs text-muted-foreground">
              updated {formatRelativeTime(starter.updatedAt)}
            </span>
          </div>
          {starter.description ? (
            <p className="truncate text-sm text-muted-foreground">
              {starter.description}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span className="truncate font-mono">{bootLabel(starter)}</span>
            {(starter.recipe.toolboxes ?? []).map((tb) => (
              <Badge key={tb} variant="outline" className="font-mono">
                {tb.split("/").pop()}
              </Badge>
            ))}
            {starter.services.map((s) => (
              <Badge key={s.id} variant="secondary">
                {s.label}
                {s.open === "external" ? (
                  <ExternalLink className="ml-1 size-3" />
                ) : null}
              </Badge>
            ))}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link
              to="/settings/launchpad/$id"
              params={{ id: starter.id }}
              search={{ owner }}
            >
              <Pencil />
              Edit
            </Link>
          </Button>
          <Button
            variant="outline"
            size="icon"
            aria-label="Delete starter"
            loading={remove.isPending}
            onClick={() => setConfirmOpen(true)}
          >
            <Trash2 />
          </Button>
        </div>
      </CardContent>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Delete this starter?"
        description={
          <>
            <strong>{starter.title}</strong> disappears from the Launchpad.
            Workspaces already launched from it keep working.
          </>
        }
        onConfirm={() => remove.mutate(starter.id)}
      />
    </Card>
  );
}
