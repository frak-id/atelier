import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/api/client";
import { unwrap } from "./error";
import { queryKeys } from "./keys";

export type OrgMemberRole = "owner" | "member";

export function organizationsListQuery() {
  return queryOptions({
    queryKey: queryKeys.organizations.list(),
    queryFn: async () => {
      return unwrap(
        await api.api.organizations.get(),
        "Failed to load organizations",
      );
    },
  });
}

export function orgMembersQuery(orgId: string) {
  return queryOptions({
    queryKey: queryKeys.organizations.members(orgId),
    queryFn: async () => {
      return unwrap(
        await api.api.organizations({ id: orgId }).members.get(),
        "Failed to load members",
      );
    },
  });
}

export function useCreateOrganization() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: { name: string; slug: string }) => {
      return unwrap(
        await api.api.organizations.post(body),
        "Failed to create organization",
      );
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
      unwrap(
        await api.api.organizations({ id: orgId }).members.post(body),
        "Failed to add member",
      );
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
      return unwrap(
        await api.api.organizations({ id: orgId }).patch(body),
        "Failed to update organization",
      );
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
      unwrap(
        await api.api.organizations({ id: orgId }).delete(),
        "Failed to delete organization",
      );
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
      unwrap(
        await api.api
          .organizations({ id: orgId })
          .members({ userId })
          .patch({ role }),
        "Failed to update member role",
      );
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
      unwrap(
        await api.api.organizations({ id: orgId }).members({ userId }).delete(),
        "Failed to remove member",
      );
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
