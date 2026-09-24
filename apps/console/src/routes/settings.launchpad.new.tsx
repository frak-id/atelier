import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { StarterEditor } from "@/components/launchpad/starter-editor";

export const Route = createFileRoute("/settings/launchpad/new")({
  validateSearch: (search: Record<string, unknown>) => ({
    owner: typeof search.owner === "string" ? search.owner : "user",
  }),
  component: NewStarterPage,
});

function NewStarterPage() {
  const { owner } = Route.useSearch();
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Link
        to="/settings/launchpad"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        Back to starters
      </Link>
      <h1 className="text-xl font-semibold">New starter</h1>
      <StarterEditor owner={owner} />
    </div>
  );
}
