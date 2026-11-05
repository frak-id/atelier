import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/api/client";
import { unwrap } from "./error";
import { queryKeys } from "./keys";

type ConfigResponse = NonNullable<
  Awaited<ReturnType<typeof api.api.config.get>>["data"]
>;
export type ConfigEntry = ConfigResponse[number];

/** Server-wide runtime config (GET /api/config) — every key with its current
 * value, type, and default, for the settings config page. */
export function serverConfigQuery() {
  return queryOptions({
    queryKey: queryKeys.config.list(),
    queryFn: async () => {
      return unwrap(await api.api.config.get(), "Failed to load config");
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
      value: boolean | number | string;
    }) => {
      unwrap(
        await api.api.config({ key }).put({ value }),
        "Failed to update config",
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.config.all });
      toast.success("Config updated");
    },
    onError: (error) => toast.error(error.message),
  });
}
