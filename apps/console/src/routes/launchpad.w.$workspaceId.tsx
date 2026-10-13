import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";
import { workspaceQuery } from "@/api/queries/launchpad";
import { WorkspaceHeader } from "@/components/launchpad/workspace-header";
import { WorkspacePhasePanel } from "@/components/launchpad/workspace-phase-panel";
import { WorkspaceWorkbench } from "@/components/launchpad/workspace-workbench";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

interface WorkspaceSearch {
  /** Open the name field right away: just launched, or "rename" from a
   * Launchpad card. */
  edit?: boolean;
}

export const Route = createFileRoute("/launchpad/w/$workspaceId")({
  validateSearch: (search: Record<string, unknown>): WorkspaceSearch => ({
    edit: search.edit === true || search.edit === "true" ? true : undefined,
  }),
  component: WorkspacePage,
});

function WorkspacePage() {
  const { workspaceId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const {
    data: workspace,
    isPending,
    isError,
    error,
  } = useQuery(workspaceQuery(workspaceId));
  // Read once: a refresh shouldn't re-open the name field.
  const [editName] = useState(search.edit === true);
  useEffect(() => {
    if (search.edit) {
      navigate({
        to: "/launchpad/w/$workspaceId",
        params: { workspaceId },
        search: {},
        replace: true,
      });
    }
  }, [search.edit, navigate, workspaceId]);

  if (isPending) {
    return (
      <div className="mx-auto w-full max-w-6xl space-y-4 px-4 py-8">
        <Skeleton className="h-10 w-80" />
        <Skeleton className="h-5 w-96" />
        <Skeleton className="h-[60vh] w-full" />
      </div>
    );
  }

  if (isError || !workspace) {
    const missing = (error as { status?: number } | null)?.status === 404;
    return (
      <div className="mx-auto flex w-full max-w-md flex-col items-center gap-4 px-4 py-24 text-center">
        <AlertTriangle className="size-8 text-muted-foreground" />
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">
            {missing
              ? "This workspace is gone"
              : "Couldn't open this workspace"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {missing
              ? "It was deleted, or it belongs to someone else."
              : error instanceof Error
                ? error.message
                : "Please try again in a moment."}
          </p>
        </div>
        <Button asChild>
          <Link to="/launchpad">Back to the Launchpad</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <WorkspaceHeader workspace={workspace} editName={editName} />
      {workspace.phase === "ready" ? (
        <WorkspaceWorkbench workspace={workspace} />
      ) : (
        <WorkspacePhasePanel workspace={workspace} />
      )}
    </div>
  );
}
