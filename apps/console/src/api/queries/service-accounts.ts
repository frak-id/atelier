import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/api/client";
import type { createBody, updateBody } from "@/lib/service-accounts";
import { unwrap } from "./error";
import { queryKeys } from "./keys";

export function serviceAccountsListQuery() {
  return queryOptions({
    queryKey: queryKeys.serviceAccounts.list(),
    queryFn: async () => {
      return unwrap(
        await api.api["service-accounts"].get(),
        "Failed to load service accounts",
      );
    },
  });
}

export function useCreateServiceAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    // Request/response carry secrets (key, private key, token): don't keep them.
    gcTime: 0,
    mutationFn: async (body: ReturnType<typeof createBody>) => {
      return unwrap(
        await api.api["service-accounts"].post(body),
        "Failed to create service account",
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.serviceAccounts.all,
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.users.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.organizations.all });
      toast.success("Service account created");
    },
    onError: (error) => toast.error(error.message),
  });
}

export function useUpdateServiceAccount(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    // Request/response carry secrets (key, private key, token): don't keep them.
    gcTime: 0,
    mutationFn: async (body: ReturnType<typeof updateBody>) => {
      return unwrap(
        await api.api["service-accounts"]({ id }).patch(body),
        "Failed to update service account",
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.serviceAccounts.all,
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.users.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.organizations.all });
      toast.success("Service account updated");
    },
    onError: (error) => toast.error(error.message),
  });
}

export function useDeleteServiceAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      unwrap(
        await api.api["service-accounts"]({ id }).delete(),
        "Failed to delete service account",
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.serviceAccounts.all,
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.users.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.organizations.all });
      toast.success("Service account deleted");
    },
    onError: (error) => toast.error(error.message),
  });
}

export function serviceAccountKeysQuery(id: string) {
  return queryOptions({
    queryKey: queryKeys.serviceAccounts.keys(id),
    queryFn: async () => {
      return unwrap(
        await api.api["service-accounts"]({ id })["api-keys"].get(),
        "Failed to load API keys",
      );
    },
  });
}

export function useCreateServiceAccountKey(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    // Request/response carry secrets (key, private key, token): don't keep them.
    gcTime: 0,
    mutationFn: async (body: {
      name: string;
      expiresAt?: string;
      scope?: "full" | "mcp";
    }) => {
      return unwrap(
        await api.api["service-accounts"]({ id })["api-keys"].post(body),
        "Failed to create API key",
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.serviceAccounts.keys(id),
      });
    },
    onError: (error) => toast.error(error.message),
  });
}

export function useRevokeServiceAccountKey(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (keyId: string) => {
      unwrap(
        await api.api["service-accounts"]({ id })
          ["api-keys"]({ keyId })
          .delete(),
        "Failed to revoke API key",
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.serviceAccounts.keys(id),
      });
      toast.success("API key revoked");
    },
    onError: (error) => toast.error(error.message),
  });
}

export function useCheckServiceAccountGithub(id: string) {
  return useMutation({
    mutationFn: async () => {
      return unwrap(
        await api.api["service-accounts"]({ id }).github.check.post(),
        "Connection test failed",
      );
    },
  });
}
