import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { startersQuery } from "@/api/queries/launchpad";
import { organizationsListQuery } from "@/api/queries/organizations";
import { StarterEditor } from "@/components/launchpad/starter-editor";
import { Skeleton } from "@/components/ui/skeleton";
import { pickDefaultOrgId } from "@/lib/orgs";

export const Route = createFileRoute("/settings/launchpad/$id")({
  validateSearch: (search: Record<string, unknown>) => ({
    // "" (or a stale "user" deep link) resolves to the caller's personal org
    // below — a starter always belongs to an org now.
    owner: typeof search.owner === "string" ? search.owner : "",
  }),
  component: EditStarterPage,
});

function EditStarterPage() {
  const { id } = Route.useParams();
  const { owner: ownerParam } = Route.useSearch();
  const ownerIsOrg = ownerParam.startsWith("org:");
  const orgsQuery = useQuery({
    ...organizationsListQuery(),
    enabled: !ownerIsOrg,
  });
  const owner = ownerIsOrg
    ? ownerParam
    : orgsQuery.data
      ? `org:${pickDefaultOrgId(orgsQuery.data)}`
      : "";
  const {
    data: starters,
    isPending,
    isError,
    error,
  } = useQuery({ ...startersQuery(owner), enabled: !!owner });
  const starter = starters?.find((s) => s.id === id);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Link
        to="/settings/launchpad"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        Back to starters
      </Link>
      <h1 className="text-xl font-semibold">Edit starter</h1>
      {isPending ? (
        <Skeleton className="h-96 w-full" />
      ) : isError ? (
        <p className="text-sm text-destructive">{error.message}</p>
      ) : !starter ? (
        <p className="text-sm text-muted-foreground">
          Starter not found in this scope.
        </p>
      ) : (
        <StarterEditor key={starter.id} starter={starter} owner={owner} />
      )}
    </div>
  );
}
