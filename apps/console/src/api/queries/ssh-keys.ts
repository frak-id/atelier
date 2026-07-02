import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/api/client";
import { errorMessage } from "./error";
import { queryKeys } from "./keys";

export function sshKeysListQuery() {
  return queryOptions({
    queryKey: queryKeys.sshKeys.list(),
    queryFn: async () => {
      const { data, error } = await api.api["ssh-keys"].get();
      if (error)
        throw new Error(errorMessage(error, "Failed to load SSH keys"));
      return data;
    },
  });
}

export function useCreateSshKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: { name: string; publicKey: string }) => {
      const { error } = await api.api["ssh-keys"].post({
        ...body,
        type: "uploaded",
      });
      if (error) throw new Error(errorMessage(error, "Failed to add SSH key"));
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
      const { error } = await api.api["ssh-keys"]({ id }).delete();
      if (error)
        throw new Error(errorMessage(error, "Failed to delete SSH key"));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sshKeys.all });
      toast.success("SSH key deleted");
    },
    onError: (error) => toast.error(error.message),
  });
}
