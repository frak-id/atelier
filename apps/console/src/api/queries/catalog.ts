import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/api/client";
import { errorMessage } from "./error";
import { queryKeys } from "./keys";

export function catalogListQuery() {
  return queryOptions({
    queryKey: queryKeys.catalog.list(),
    queryFn: async () => {
      const { data, error } = await api.v1.catalog.get();
      if (error) throw new Error(errorMessage(error, "Failed to load catalog"));
      return data;
    },
  });
}

export function useAddCatalogEntry() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      name: string;
      url: string;
      sha256: string;
      path?: string;
      executable?: boolean;
    }) => {
      const { error } = await api.v1.catalog.post(body);
      if (error)
        throw new Error(errorMessage(error, "Failed to add catalog entry"));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.catalog.all });
      toast.success("Artifact added");
    },
    onError: (error) => toast.error(error.message),
  });
}
