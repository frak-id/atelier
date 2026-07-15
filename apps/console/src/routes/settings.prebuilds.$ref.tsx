import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { prebuildsListQuery } from "@/api/queries/prebuilds";
import { PrebuildEditor } from "@/components/prebuild-editor";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/settings/prebuilds/$ref")({
  component: EditPrebuildPage,
});

/**
 * Edits an existing prebuild by replaying its stored `.spec` through the
 * visual/JSON editor. There's no single-prebuild GET endpoint, so this reuses
 * the list query (already cached from the settings page in the common case)
 * and finds the record by ref client-side.
 */
function EditPrebuildPage() {
  const { ref } = Route.useParams();
  const {
    data: prebuilds,
    isPending,
    isError,
    error,
  } = useQuery(prebuildsListQuery());

  const record = prebuilds?.find((p) => p.ref === ref);

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Link
        to="/settings/prebuilds"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        Back to prebuilds
      </Link>
      <h1 className="truncate font-mono text-xl font-semibold">{ref}</h1>
      {isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : isError ? (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load prebuild"}
        </p>
      ) : !record ? (
        <p className="text-sm text-muted-foreground">
          Prebuild not found.{" "}
          <Link to="/settings/prebuilds" className="underline">
            Back to prebuilds
          </Link>
        </p>
      ) : !record.spec ? (
        <p className="text-sm text-muted-foreground">
          This snapshot has no stored recipe (a pause or manual snapshot), so it
          can't be replayed in the editor.{" "}
          <Link to="/settings/prebuilds" className="underline">
            Back to prebuilds
          </Link>
        </p>
      ) : (
        <PrebuildEditor key={ref} spec={record.spec} />
      )}
    </div>
  );
}
