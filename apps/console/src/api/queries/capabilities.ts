import { queryOptions } from "@tanstack/react-query";
import { api } from "@/api/client";
import { errorMessage } from "./error";
import { queryKeys } from "./keys";

/**
 * Which harness composers this server has registered (design
 * ui-evolution.md §3.1) — drives harness pickers/badges as data instead of a
 * hardcoded list, so a claude-code/pi-first org sees their own stack.
 */
export function capabilitiesQuery() {
  return queryOptions({
    queryKey: queryKeys.capabilities.all,
    queryFn: async () => {
      const { data, error } = await api.api.capabilities.get();
      if (error)
        throw new Error(errorMessage(error, "Failed to load capabilities"));
      return data;
    },
    staleTime: 5 * 60_000,
  });
}
