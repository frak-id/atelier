import type { PrebuildRecord, StarterInput } from "@atelier/spec";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { prebuildsListQuery } from "@/api/queries/prebuilds";
import { serverConfigQuery } from "@/api/queries/server-config";
import { StarterEditor } from "@/components/launchpad/starter-editor";
import { Skeleton } from "@/components/ui/skeleton";
import { useDefaultImage } from "@/hooks/use-repo-catalog";
import { prebuildTitle } from "@/lib/formatters";
import { blankStarterInput, withStoredPrebuild } from "@/lib/starter-recipe";

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

/** A new starter that boots from a stored prebuild, named after what it
 * contains (the author renames it). */
function starterFromPrebuild(
  record: PrebuildRecord,
  image: string,
): StarterInput {
  const blank = blankStarterInput(image);
  return {
    ...blank,
    title: `Work on ${prebuildTitle(record)}`.slice(0, 80),
    recipe: withStoredPrebuild(blank.recipe, record),
  };
}

function NewStarterPage() {
  const { owner, prebuild: prebuildRef } = Route.useSearch();
  // The form seeds its image from the server's default: wait for it (an
  // error falls back to the built-in default) instead of baking in a guess.
  const config = useQuery(serverConfigQuery());
  const defaultImage = useDefaultImage();
  const prebuildsList = useQuery({
    ...prebuildsListQuery(),
    enabled: !!prebuildRef,
  });

  const waitingOnPrebuild = !!prebuildRef && prebuildsList.isPending;
  const pending = config.isPending || waitingOnPrebuild;

  let initial: StarterInput | undefined;
  let notice: string | undefined;
  if (prebuildRef && !waitingOnPrebuild) {
    const record = prebuildsList.data?.find((p) => p.ref === prebuildRef);
    if (record) {
      initial = starterFromPrebuild(record, defaultImage);
    } else {
      notice = `Prebuild "${prebuildRef}" wasn't found. Starting from a blank starter.`;
    }
  }

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
      {notice ? <p className="text-sm text-warning">{notice}</p> : null}
      {pending ? (
        <Skeleton className="h-96 w-full" />
      ) : (
        <StarterEditor owner={owner} initial={initial} />
      )}
    </div>
  );
}
