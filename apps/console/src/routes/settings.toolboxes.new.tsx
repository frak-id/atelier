import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { ToolboxEditor } from "@/components/toolbox-editor";

export const Route = createFileRoute("/settings/toolboxes/new")({
  validateSearch: (search: Record<string, unknown>) => ({
    owner: typeof search.owner === "string" ? search.owner : "user",
  }),
  component: NewToolboxPage,
});

function NewToolboxPage() {
  const { owner } = Route.useSearch();
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Link
        to="/settings/toolboxes"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        Back to toolboxes
      </Link>
      <h1 className="text-xl font-semibold">Add toolbox</h1>
      <ToolboxEditor owner={owner} />
    </div>
  );
}
