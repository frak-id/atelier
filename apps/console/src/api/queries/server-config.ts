import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/api/client";
import { errorMessage } from "./error";
import { queryKeys } from "./keys";

/** Server-wide runtime config (GET /api/config) — every key with its current
 * value, type, and default, for the settings config page. */
export function serverConfigQuery() {
  return queryOptions({
    queryKey: queryKeys.config.list(),
    queryFn: async () => {
      const { data, error } = await api.api.config.get();
      if (error) throw new Error(errorMessage(error, "Failed to load config"));
      return data;
    },
  });
}

/** Set one config key (PUT /api/config/:key). */
export function useSetConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      key,
      value,
    }: {
      key: string;
      value: boolean | number;
    }) => {
      const { error } = await api.api.config({ key }).put({ value });
      if (error)
        throw new Error(errorMessage(error, "Failed to update config"));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.config.all });
      toast.success("Config updated");
    },
    onError: (error) => toast.error(error.message),
  });
}
