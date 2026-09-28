import { queryOptions } from "@tanstack/react-query";
import { api } from "@/api/client";
import { errorMessage } from "./error";
import { queryKeys } from "./keys";

/** The user directory: every registered user + their org memberships. Backs
 * the console's Users page and the add-member picker. */
export function usersDirectoryQuery() {
  return queryOptions({
    queryKey: queryKeys.users.directory(),
    queryFn: async () => {
      const { data, error } = await api.api.users.get();
      if (error) throw new Error(errorMessage(error, "Failed to load users"));
      return data;
    },
    staleTime: 30_000,
  });
}
