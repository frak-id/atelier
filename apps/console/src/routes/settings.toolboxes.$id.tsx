import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { toolboxesListQuery } from "@/api/queries/toolboxes";
import { ToolboxEditor } from "@/components/toolbox-editor";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/settings/toolboxes/$id")({
  validateSearch: (search: Record<string, unknown>) => ({
    owner: typeof search.owner === "string" ? search.owner : "user",
  }),
  component: EditToolboxPage,
});

function EditToolboxPage() {
  const { id } = Route.useParams();
  const { owner } = Route.useSearch();
  const {
    data: toolboxes,
    isPending,
    isError,
    error,
  } = useQuery(toolboxesListQuery(owner));
  const toolbox = toolboxes?.find((t) => t.id === id);

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Link
        to="/settings/toolboxes"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        Back to toolboxes
      </Link>
      <h1 className="text-xl font-semibold">Edit toolbox</h1>
      {isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : isError ? (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load toolbox"}
        </p>
      ) : !toolbox ? (
        <p className="text-sm text-muted-foreground">
          Toolbox not found in this scope.
        </p>
      ) : (
        <ToolboxEditor key={toolbox.id} toolbox={toolbox} owner={owner} />
      )}
    </div>
  );
}
