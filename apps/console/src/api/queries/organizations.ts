import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/api/client";
import { errorMessage } from "./error";
import { queryKeys } from "./keys";

export type OrgMemberRole = "owner" | "admin" | "member" | "viewer";

export function organizationsListQuery() {
  return queryOptions({
    queryKey: queryKeys.organizations.list(),
    queryFn: async () => {
      const { data, error } = await api.api.organizations.get();
      if (error)
        throw new Error(errorMessage(error, "Failed to load organizations"));
      return data;
    },
  });
}

export function orgMembersQuery(orgId: string) {
  return queryOptions({
    queryKey: queryKeys.organizations.members(orgId),
    queryFn: async () => {
      const { data, error } = await api.api
        .organizations({ id: orgId })
        .members.get();
      if (error) throw new Error(errorMessage(error, "Failed to load members"));
      return data;
    },
  });
}

export function useCreateOrganization() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: { name: string; slug: string }) => {
      const { data, error } = await api.api.organizations.post(body);
      if (error)
        throw new Error(errorMessage(error, "Failed to create organization"));
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.organizations.all });
      toast.success("Organization created");
    },
    onError: (error) => toast.error(error.message),
  });
}

export function useAddOrgMember(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: { userId: string; role: OrgMemberRole }) => {
      const { error } = await api.api
        .organizations({ id: orgId })
        .members.post(body);
      if (error) throw new Error(errorMessage(error, "Failed to add member"));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.organizations.members(orgId),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.users.all });
      toast.success("Member added");
    },
    onError: (error) => toast.error(error.message),
  });
}

export function useRenameOrganization(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: { name?: string; slug?: string }) => {
      const { data, error } = await api.api
        .organizations({ id: orgId })
        .patch(body);
      if (error)
        throw new Error(errorMessage(error, "Failed to update organization"));
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.organizations.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.users.all });
      toast.success("Organization updated");
    },
    onError: (error) => toast.error(error.message),
  });
}

export function useDeleteOrganization() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (orgId: string) => {
      const { error } = await api.api.organizations({ id: orgId }).delete();
      if (error)
        throw new Error(errorMessage(error, "Failed to delete organization"));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.organizations.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.users.all });
      toast.success("Organization deleted");
    },
    onError: (error) => toast.error(error.message),
  });
}

export function useUpdateOrgMemberRole(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      userId,
      role,
    }: {
      userId: string;
      role: OrgMemberRole;
    }) => {
      const { error } = await api.api
        .organizations({ id: orgId })
        .members({ userId })
        .patch({ role });
      if (error)
        throw new Error(errorMessage(error, "Failed to update member role"));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.organizations.members(orgId),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.users.all });
      toast.success("Role updated");
    },
    onError: (error) => toast.error(error.message),
  });
}

/** Removes a member, or — when `userId` is the caller — leaves the org (same
 * endpoint on the server; `isSelf` only changes the toast copy). */
export function useRemoveOrgMember(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ userId }: { userId: string; isSelf?: boolean }) => {
      const { error } = await api.api
        .organizations({ id: orgId })
        .members({ userId })
        .delete();
      if (error)
        throw new Error(errorMessage(error, "Failed to remove member"));
    },
    onSuccess: (_data, { isSelf }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.organizations.members(orgId),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.organizations.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.users.all });
      toast.success(isSelf ? "Left organization" : "Member removed");
    },
    onError: (error) => toast.error(error.message),
  });
}
