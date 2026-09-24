import { useQueries, useQuery } from "@tanstack/react-query";
import { organizationsListQuery } from "@/api/queries/organizations";
import { toolboxesListQuery } from "@/api/queries/toolboxes";

/** Every toolbox the caller can apply: their own + each org's, flattened.
 * Shared by the spawn page and the Launchpad starter editor. */
export function useAllToolboxes() {
  const { data: orgs } = useQuery(organizationsListQuery());
  const owners = ["user", ...(orgs ?? []).map((org) => `org:${org.id}`)];
  const results = useQueries({
    queries: owners.map((owner) => toolboxesListQuery(owner)),
  });
  return results.flatMap((r) => r.data ?? []);
}
