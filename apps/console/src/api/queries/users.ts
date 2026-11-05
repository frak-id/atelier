import { queryOptions } from "@tanstack/react-query";
import { api } from "@/api/client";
import { unwrap } from "./error";
import { queryKeys } from "./keys";

/** The user directory: every registered user + their org memberships. Backs
 * the console's Users page and the add-member picker. */
export function usersDirectoryQuery() {
  return queryOptions({
    queryKey: queryKeys.users.directory(),
    queryFn: async () => {
      return unwrap(await api.api.users.get(), "Failed to load users");
    },
    staleTime: 30_000,
  });
}
