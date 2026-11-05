import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/api/client";
import { unwrap } from "./error";
import { queryKeys } from "./keys";

/** How often the inbox refreshes while the tab is visible. */
const TASK_POLL_MS = 10_000;

async function fetchTasks() {
  return unwrap(
    await api.sessions.tasks.get({ query: { limit: 200 } }),
    "Failed to load tasks",
  );
}

export type InboxTask = Awaited<ReturnType<typeof fetchTasks>>[number];

/** Every task of every sandbox the caller can reach, newest first. */
export function tasksListQuery() {
  return queryOptions({
    queryKey: queryKeys.tasks.list(),
    queryFn: fetchTasks,
    refetchInterval: TASK_POLL_MS,
    refetchIntervalInBackground: false,
  });
}

function useInvalidateTasks() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
}

/** Start a task from the console (`POST /sessions/tasks`). */
export function useStartTask() {
  const invalidate = useInvalidateTasks();
  return useMutation({
    mutationFn: async (input: {
      sandboxId: string;
      prompt: string;
      cwd?: string;
    }) =>
      unwrap(
        await api.sessions.tasks.post({
          sandboxId: input.sandboxId,
          prompt: input.prompt,
          ...(input.cwd ? { cwd: input.cwd } : {}),
        }),
        "Failed to start task",
      ),
    onSuccess: () => {
      invalidate();
      toast.success("Task started");
    },
    onError: (error) => toast.error(error.message),
  });
}

export function useSendTaskPrompt() {
  const invalidate = useInvalidateTasks();
  return useMutation({
    mutationFn: async ({ taskId, text }: { taskId: string; text: string }) =>
      unwrap(
        await api.sessions.tasks({ taskId }).prompt.post({ text }),
        "Failed to send prompt",
      ),
    onSuccess: () => {
      invalidate();
      toast.success("Prompt sent");
    },
    onError: (error) => toast.error(error.message),
  });
}

export function useCancelTask() {
  const invalidate = useInvalidateTasks();
  return useMutation({
    mutationFn: async (taskId: string) =>
      unwrap(
        await api.sessions.tasks({ taskId }).cancel.post(),
        "Failed to cancel task",
      ),
    onSuccess: () => {
      invalidate();
      toast.success("Task cancelled");
    },
    onError: (error) => toast.error(error.message),
  });
}

export function useCloseTask() {
  const invalidate = useInvalidateTasks();
  return useMutation({
    mutationFn: async (taskId: string) =>
      unwrap(
        await api.sessions.tasks({ taskId }).delete(),
        "Failed to close task",
      ),
    onSuccess: () => {
      invalidate();
      toast.success("Task closed");
    },
    onError: (error) => toast.error(error.message),
  });
}
