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
      toast.success("Member added");
    },
    onError: (error) => toast.error(error.message),
  });
}
