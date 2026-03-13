import { queryOptions, useMutation } from "@tanstack/react-query";
import type { OrgMemberRole } from "../client";
import { api } from "../client";
import { queryKeys, unwrap } from "./keys";

export const organizationListQuery = () =>
  queryOptions({
    queryKey: queryKeys.organizations.list(),
    queryFn: async () => unwrap(await api.api.organizations.get()),
  });

export const organizationDetailQuery = (slug: string) =>
  queryOptions({
    queryKey: queryKeys.organizations.detail(slug),
    queryFn: async () =>
      unwrap(await api.api.organizations({ orgSlug: slug }).get()),
    enabled: !!slug,
  });

export const organizationMembersQuery = (slug: string) =>
  queryOptions({
    queryKey: queryKeys.organizations.members(slug),
    queryFn: async () =>
      unwrap(await api.api.organizations({ orgSlug: slug }).members.get()),
    enabled: !!slug,
  });

export function useCreateOrganization() {
  return useMutation({
    mutationKey: ["organizations", "create"],
    mutationFn: async (data: { name: string; slug: string }) =>
      unwrap(await api.api.organizations.post(data)),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.organizations.all,
      });
    },
  });
}

export function useUpdateOrganization() {
  return useMutation({
    mutationKey: ["organizations", "update"],
    mutationFn: async ({
      slug,
      data,
    }: {
      slug: string;
      data: { name?: string; avatarUrl?: string };
    }) => unwrap(await api.api.organizations({ orgSlug: slug }).put(data)),
    onSuccess: (_data, variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.organizations.all,
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.organizations.detail(variables.slug),
      });
    },
  });
}

export function useDeleteOrganization() {
  return useMutation({
    mutationKey: ["organizations", "delete"],
    mutationFn: async (slug: string) =>
      unwrap(await api.api.organizations({ orgSlug: slug }).delete()),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.organizations.all,
      });
    },
  });
}

export function useAddOrgMember() {
  return useMutation({
    mutationKey: ["organizations", "members", "add"],
    mutationFn: async ({
      slug,
      data,
    }: {
      slug: string;
      data: { userId: string; role?: OrgMemberRole };
    }) =>
      unwrap(await api.api.organizations({ orgSlug: slug }).members.post(data)),
    onSuccess: (_data, variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.organizations.members(variables.slug),
      });
    },
  });
}

export function useUpdateOrgMemberRole() {
  return useMutation({
    mutationKey: ["organizations", "members", "updateRole"],
    mutationFn: async ({
      slug,
      memberId,
      role,
    }: {
      slug: string;
      memberId: string;
      role: OrgMemberRole;
    }) =>
      unwrap(
        await api.api
          .organizations({ orgSlug: slug })
          .members({ memberId })
          .put({ role }),
      ),
    onSuccess: (_data, variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.organizations.members(variables.slug),
      });
    },
  });
}

export function useRemoveOrgMember() {
  return useMutation({
    mutationKey: ["organizations", "members", "remove"],
    mutationFn: async ({
      slug,
      memberId,
    }: {
      slug: string;
      memberId: string;
    }) =>
      unwrap(
        await api.api
          .organizations({ orgSlug: slug })
          .members({ memberId })
          .delete(),
      ),
    onSuccess: (_data, variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.organizations.members(variables.slug),
      });
    },
  });
}
