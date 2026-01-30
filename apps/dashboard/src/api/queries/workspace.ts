import { queryOptions, useMutation, useQuery } from "@tanstack/react-query";
import { api, type Workspace } from "../client";
import { queryKeys, unwrap } from "./keys";

export const workspaceListQuery = () =>
  queryOptions({
    queryKey: queryKeys.workspaces.list(),
    queryFn: async () => unwrap(await api.api.workspaces.get()),
  });

export function useWorkspaceMap() {
  const { data } = useQuery({
    ...workspaceListQuery(),
    select: (workspaces) => {
      const map = new Map<string, string>();
      for (const w of workspaces ?? []) {
        map.set(w.id, w.name);
      }
      return map;
    },
  });
  return data ?? new Map<string, string>();
}

export function useWorkspaceDataMap() {
  const { data } = useQuery({
    ...workspaceListQuery(),
    select: (workspaces) => {
      const map = new Map<string, Workspace>();
      for (const w of workspaces ?? []) {
        map.set(w.id, w);
      }
      return map;
    },
  });
  return data ?? new Map<string, Workspace>();
}

export const workspaceDetailQuery = (id: string) =>
  queryOptions({
    queryKey: queryKeys.workspaces.detail(id),
    queryFn: async () => unwrap(await api.api.workspaces({ id }).get()),
  });

export const imageListQuery = (all?: boolean) =>
  queryOptions({
    queryKey: queryKeys.images.list(all),
    queryFn: async () =>
      unwrap(await api.api.images.get({ query: { all: all ?? undefined } })),
  });

export function useCreateWorkspace() {
  return useMutation({
    mutationKey: ["workspaces", "create"],
    mutationFn: async (data: {
      name: string;
      config?: Record<string, unknown>;
    }) => unwrap(await api.api.workspaces.post(data)),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all });
    },
  });
}

export function useUpdateWorkspace() {
  return useMutation({
    mutationKey: ["workspaces", "update"],
    mutationFn: async ({
      id,
      data,
    }: {
      id: string;
      data: { name?: string; config?: Record<string, unknown> };
    }) => unwrap(await api.api.workspaces({ id }).put(data)),
    onSuccess: (_data, variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all });
      queryClient.invalidateQueries({
        queryKey: queryKeys.workspaces.detail(variables.id),
      });
    },
  });
}

export function useDeleteWorkspace() {
  return useMutation({
    mutationKey: ["workspaces", "delete"],
    mutationFn: async (id: string) =>
      unwrap(await api.api.workspaces({ id }).delete()),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all });
    },
  });
}

export function useTriggerPrebuild() {
  return useMutation({
    mutationKey: ["workspaces", "triggerPrebuild"],
    mutationFn: async (id: string) =>
      unwrap(await api.api.workspaces({ id }).prebuild.post()),
    onSuccess: (_data, id, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all });
      queryClient.invalidateQueries({
        queryKey: queryKeys.workspaces.detail(id),
      });
    },
  });
}

export function useDeletePrebuild() {
  return useMutation({
    mutationKey: ["workspaces", "deletePrebuild"],
    mutationFn: async (id: string) =>
      unwrap(await api.api.workspaces({ id }).prebuild.delete()),
    onSuccess: (_data, id, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all });
      queryClient.invalidateQueries({
        queryKey: queryKeys.workspaces.detail(id),
      });
    },
  });
}
