import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/api/client";
import { unwrap } from "./error";
import { queryKeys } from "./keys";

export function sshKeysListQuery() {
  return queryOptions({
    queryKey: queryKeys.sshKeys.list(),
    queryFn: async () => {
      return unwrap(await api.api["ssh-keys"].get(), "Failed to load SSH keys");
    },
  });
}

export function useCreateSshKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: { name: string; publicKey: string }) => {
      unwrap(
        await api.api["ssh-keys"].post({
          ...body,
          type: "uploaded",
        }),
        "Failed to add SSH key",
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sshKeys.all });
      toast.success("SSH key added");
    },
    onError: (error) => toast.error(error.message),
  });
}

export function useDeleteSshKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      unwrap(
        await api.api["ssh-keys"]({ id }).delete(),
        "Failed to delete SSH key",
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sshKeys.all });
      toast.success("SSH key deleted");
    },
    onError: (error) => toast.error(error.message),
  });
}
