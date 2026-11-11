import {
  type ToolboxConfig,
  type ToolsetEntry,
  toolboxArtifactName,
} from "@atelier/spec";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  Package,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Wrench,
} from "lucide-react";
import { useState } from "react";
import { isJobRunning, jobsListQuery } from "@/api/queries/jobs";
import {
  toolboxesListQuery,
  useDeleteToolbox,
  useRefreshToolbox,
} from "@/api/queries/toolboxes";
import { toolsetsListQuery } from "@/api/queries/toolsets";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  OwnerScopeSection,
  OwnerScopeSections,
} from "@/components/owner-scope-sections";
import { ToolboxSuggestions } from "@/components/toolbox-suggestions";
import { ToolboxVersionsPanel } from "@/components/toolbox-versions-panel";
import { ToolsetsSection } from "@/components/toolsets-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDuration, formatRelativeTime, msUntil } from "@/lib/formatters";
import type { OwnerScope } from "@/lib/orgs";

export const Route = createFileRoute("/library/toolboxes/")({
  component: ToolboxesPage,
});

function ToolboxesPage() {
  const { data: toolsets } = useQuery(toolsetsListQuery());
  const artifactByName = new Map(
    (toolsets ?? []).map((toolset) => [toolset.name, toolset] as const),
  );

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Toolboxes are org-scoped recipes (<code>build[]</code> +{" "}
        <code>paths[]</code>, plus optional <code>files</code>, processes and
        ports) that, when auto-injected, are compiled into a{" "}
        <strong>toolset</strong> (the resulting build artifact) and applied to
        every spawn in that org. Your personal toolboxes live in your personal
        org; move one into the team org to share it.
      </p>
      <OwnerScopeSections>
        {(scope) => (
          <ToolboxScopeSection
            key={scope.owner}
            scope={scope}
            artifactByName={artifactByName}
          />
        )}
      </OwnerScopeSections>
      <ToolsetsSection filter={(toolset) => !toolset.name.startsWith("tb/")} />
    </div>
  );
}

/** One org's toolboxes (any member may use, create and edit them). */
function ToolboxScopeSection({
  scope,
  artifactByName,
}: {
  scope: OwnerScope;
  artifactByName: ReadonlyMap<string, ToolsetEntry>;
}) {
  const {
    data: toolboxes,
    isPending,
    isError,
    error,
  } = useQuery(toolboxesListQuery(scope.owner));

  return (
    <OwnerScopeSection
      scope={scope}
      count={toolboxes?.length}
      actions={
        <Button size="sm" variant="outline" asChild>
          <Link to="/library/toolboxes/new" search={{ owner: scope.owner }}>
            <Plus />
            Add toolbox
          </Link>
        </Button>
      }
    >
      {isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : isError ? (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load"}
        </p>
      ) : toolboxes.length === 0 ? (
        <ToolboxSuggestions scope={scope} toolboxes={toolboxes} />
      ) : (
        <div className="space-y-2">
          {toolboxes.map((toolbox) => (
            <ToolboxRow
              key={toolbox.id}
              toolbox={toolbox}
              owner={scope.owner}
              artifact={artifactByName.get(toolboxArtifactName(toolbox))}
            />
          ))}
          <ToolboxSuggestions scope={scope} toolboxes={toolboxes} />
        </div>
      )}
    </OwnerScopeSection>
  );
}

function ToolboxRow({
  toolbox,
  owner,
  artifact,
}: {
  toolbox: ToolboxConfig;
  owner: string;
  artifact: ToolsetEntry | undefined;
}) {
  const deleteToolbox = useDeleteToolbox();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);

  return (
    <Card>
      <CardContent className="flex flex-col gap-2 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Wrench className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate font-mono text-sm">{toolbox.slug}</span>
            <span className="truncate text-sm text-muted-foreground">
              {toolbox.description}
            </span>
            <Badge variant={toolbox.autoInject ? "success" : "secondary"}>
              {toolbox.autoInject ? "auto-inject" : "manual"}
            </Badge>
            {toolbox.harness ? (
              <Badge variant="outline">harness: {toolbox.harness}</Badge>
            ) : null}
            {toolbox.processes && toolbox.processes.length > 0 ? (
              <Badge variant="outline">
                runs: {toolbox.processes.map((p) => p.name).join(", ")}
              </Badge>
            ) : null}
          </div>
          <div className="flex shrink-0 gap-1">
            <Button
              variant="outline"
              size="icon"
              asChild
              aria-label="Edit toolbox"
            >
              <Link
                to="/library/toolboxes/$id"
                params={{ id: toolbox.id }}
                search={{ owner }}
              >
                <Pencil />
              </Link>
            </Button>
            <Button
              variant="outline"
              size="icon"
              disabled={deleteToolbox.isPending}
              onClick={() => setConfirmOpen(true)}
              aria-label="Delete toolbox"
            >
              {deleteToolbox.isPending ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Trash2 />
              )}
            </Button>
          </div>
        </div>
        <div className="flex min-w-0 items-center gap-2 border-t pt-2 text-xs text-muted-foreground">
          <Package className="size-3.5 shrink-0" />
          {artifact ? (
            <>
              <span className="truncate font-mono">{artifact.ref}</span>
              <span className="shrink-0">
                built {formatRelativeTime(artifact.createdAt)}
              </span>
            </>
          ) : (
            <span>Artifact not built yet — compiled on next spawn.</span>
          )}
        </div>
        {toolbox.refresh.length > 0 || toolbox.lastRefresh ? (
          <ToolboxRefreshStrip toolbox={toolbox} />
        ) : null}
        <div className="border-t pt-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setVersionsOpen((open) => !open)}
          >
            {versionsOpen ? <ChevronDown /> : <ChevronRight />}
            Versions
          </Button>
          {/* Mounted only while open — mirrors ProcessLogs' mount-gate so N
           * toolbox rows don't fire N version queries on page load. */}
          {versionsOpen ? (
            <ToolboxVersionsPanel toolboxId={toolbox.id} />
          ) : null}
        </div>
      </CardContent>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Delete toolbox?"
        description={
          <>
            New spawns in this scope will no longer include{" "}
            <span className="font-mono">{toolbox.slug}</span>. This cannot be
            undone.
          </>
        }
        onConfirm={() => deleteToolbox.mutate(toolbox.id)}
      />
    </Card>
  );
}

/**
 * Refresh status for a toolbox (docs/toolbox-versions.md section 10): when it
 * runs, how the last one went, and a button to run it now. A refresh runs
 * the update commands over the current version on the server, then saves and
 * pins the result. "Running" comes from the live jobs feed.
 */
function ToolboxRefreshStrip({ toolbox }: { toolbox: ToolboxConfig }) {
  const refresh = useRefreshToolbox();
  const { data: jobs } = useQuery(jobsListQuery());
  const activeJob = jobs?.find(
    (job) =>
      job.kind === "toolbox-refresh" &&
      job.metadata?.toolboxId === toolbox.id &&
      (job.status === "queued" || job.status === "running"),
  );
  const last = toolbox.lastRefresh;
  const canRefresh = toolbox.refresh.length > 0;

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 border-t pt-2 text-xs text-muted-foreground">
      <RefreshCw className="size-3.5 shrink-0" />
      <span className="truncate font-mono" title={toolbox.refresh.join("\n")}>
        {toolbox.refresh.length > 0
          ? toolbox.refresh.join(" && ")
          : "no update commands"}
      </span>
      <span className="shrink-0">
        {toolbox.refreshSchedule ? (
          <>
            <span className="font-mono">{toolbox.refreshSchedule}</span> UTC
            {toolbox.nextRefreshAt
              ? ` · next in ${formatDuration(msUntil(toolbox.nextRefreshAt))}`
              : ""}
          </>
        ) : (
          "on demand"
        )}
      </span>
      {activeJob ? (
        <Badge variant="info">
          <Loader2 className="mr-1 size-3 animate-spin" />
          {isJobRunning(activeJob) ? "refreshing" : "queued"}
        </Badge>
      ) : last ? (
        <span
          className="flex min-w-0 items-center gap-1"
          title={last.error ?? undefined}
        >
          {last.outcome === "updated" ? (
            <Badge variant="success">
              {last.pinned === false ? "new version, not pinned" : "updated"}
            </Badge>
          ) : last.outcome === "unchanged" ? (
            <Badge variant="neutral">no change</Badge>
          ) : (
            <Badge variant="danger">failed</Badge>
          )}
          <span className="shrink-0">
            {last.trigger === "schedule" ? "scheduled, " : ""}
            {formatRelativeTime(last.at)}
          </span>
          {last.error ? (
            <span className="truncate text-danger">{last.error}</span>
          ) : null}
        </span>
      ) : null}
      {canRefresh ? (
        <Button
          variant="outline"
          size="sm"
          className="ml-auto h-7"
          disabled={activeJob !== undefined || refresh.isPending}
          onClick={() => refresh.mutate(toolbox.id)}
        >
          {refresh.isPending ? (
            <Loader2 className="animate-spin" />
          ) : (
            <RefreshCw />
          )}
          Refresh
        </Button>
      ) : null}
    </div>
  );
}
