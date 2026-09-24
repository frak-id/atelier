import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { serverConfigQuery } from "@/api/queries/server-config";
import { StarterEditor } from "@/components/launchpad/starter-editor";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/settings/launchpad/new")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { owner: string; prebuild?: string } => ({
    owner: typeof search.owner === "string" ? search.owner : "user",
    // Start from a stored prebuild (its ref): "Create a Launchpad starter"
    // on the prebuilds page.
    ...(typeof search.prebuild === "string" && search.prebuild
      ? { prebuild: search.prebuild }
      : {}),
  }),
  component: NewStarterPage,
});

function NewStarterPage() {
  const { owner } = Route.useSearch();
  // The form seeds its image from the server's default: wait for it (an
  // error falls back to the built-in default) instead of baking in a guess.
  const config = useQuery(serverConfigQuery());
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
      {config.isPending ? (
        <Skeleton className="h-96 w-full" />
      ) : (
        <StarterEditor owner={owner} />
      )}
    </div>
  );
}
