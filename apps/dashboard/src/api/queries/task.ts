import { queryOptions, useMutation } from "@tanstack/react-query";
import { api } from "../client";
import { queryKeys, unwrap } from "./keys";

export const taskListQuery = (workspaceId?: string) =>
  queryOptions({
    queryKey: queryKeys.tasks.list(workspaceId),
    queryFn: async () =>
      unwrap(
        await api.api.tasks.get({
          query: workspaceId ? { workspaceId } : {},
        }),
      ),
  });

export const taskDetailQuery = (id: string) =>
  queryOptions({
    queryKey: queryKeys.tasks.detail(id),
    queryFn: async () => unwrap(await api.api.tasks({ id }).get()),
  });

export function useCreateTask() {
  return useMutation({
    mutationKey: ["tasks", "create"],
    mutationFn: async (data: {
      workspaceId: string;
      title: string;
      description: string;
      context?: string;
      templateId?: string;
      variantIndex?: number;
      baseBranch?: string;
      targetRepoIndices?: number[];
    }) => unwrap(await api.api.tasks.post(data)),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
    },
  });
}

export function useUpdateTask() {
  return useMutation({
    mutationKey: ["tasks", "update"],
    mutationFn: async ({
      id,
      data,
    }: {
      id: string;
      data: {
        title?: string;
        description?: string;
        context?: string;
        templateId?: string;
        variantIndex?: number;
      };
    }) => unwrap(await api.api.tasks({ id }).put(data)),
    onSuccess: (_data, variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.detail(variables.id),
      });
    },
  });
}

export function useStartTask() {
  return useMutation({
    mutationKey: ["tasks", "start"],
    mutationFn: async (id: string) =>
      unwrap(await api.api.tasks({ id }).start.post()),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.sandboxes.all });
    },
  });
}

export function useAddTaskSessions() {
  return useMutation({
    mutationKey: ["tasks", "addSessions"],
    mutationFn: async ({
      id,
      sessionTemplateIds,
    }: {
      id: string;
      sessionTemplateIds: string[];
    }) =>
      unwrap(await api.api.tasks({ id }).sessions.post({ sessionTemplateIds })),
    onSuccess: (_data, variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.detail(variables.id),
      });
    },
  });
}

export function useCompleteTask() {
  return useMutation({
    mutationKey: ["tasks", "complete"],
    mutationFn: async (id: string) =>
      unwrap(await api.api.tasks({ id }).complete.post()),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
    },
  });
}

export function useResetTask() {
  return useMutation({
    mutationKey: ["tasks", "reset"],
    mutationFn: async ({
      id,
      sandboxAction,
    }: {
      id: string;
      sandboxAction?: "detach" | "stop" | "destroy";
    }) =>
      unwrap(
        await api.api.tasks({ id }).reset.post(undefined, {
          query: sandboxAction ? { sandboxAction } : {},
        }),
      ),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.sandboxes.all });
    },
  });
}

export function useReorderTask() {
  return useMutation({
    mutationKey: ["tasks", "reorder"],
    mutationFn: async ({ id, order }: { id: string; order: number }) =>
      unwrap(await api.api.tasks({ id }).order.put({ order })),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
    },
  });
}

export function useDeleteTask() {
  return useMutation({
    mutationKey: ["tasks", "delete"],
    mutationFn: async ({
      id,
      sandboxAction,
    }: {
      id: string;
      sandboxAction?: "detach" | "stop" | "destroy";
    }) =>
      unwrap(
        await api.api.tasks({ id }).delete({
          query: sandboxAction ? { sandboxAction } : {},
        }),
      ),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.sandboxes.all });
    },
  });
}
