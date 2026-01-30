import { queryOptions, useMutation } from "@tanstack/react-query";
import {
  deleteOpenCodeSession,
  fetchOpenCodePermissions,
  fetchOpenCodeQuestions,
  fetchOpenCodeSessions,
  fetchOpenCodeTodos,
  getOpenCodeSessionStatuses,
} from "../opencode";
import { queryKeys } from "./keys";

export const opencodeSessionsQuery = (baseUrl: string) =>
  queryOptions({
    queryKey: queryKeys.opencode.sessions(baseUrl),
    queryFn: () => fetchOpenCodeSessions(baseUrl),
    refetchInterval: 10000,
    refetchIntervalInBackground: false,
    enabled: !!baseUrl,
  });

export const opencodePermissionsQuery = (baseUrl: string) =>
  queryOptions({
    queryKey: queryKeys.opencode.permissions(baseUrl),
    queryFn: () => fetchOpenCodePermissions(baseUrl),
    enabled: !!baseUrl,
  });

export const opencodeQuestionsQuery = (baseUrl: string) =>
  queryOptions({
    queryKey: queryKeys.opencode.questions(baseUrl),
    queryFn: () => fetchOpenCodeQuestions(baseUrl),
    enabled: !!baseUrl,
  });

export const opencodeSessionStatusesQuery = (baseUrl: string) =>
  queryOptions({
    queryKey: queryKeys.opencode.sessionStatuses(baseUrl),
    queryFn: () => getOpenCodeSessionStatuses(baseUrl),
    enabled: !!baseUrl,
  });

export const opencodeTodosQuery = (baseUrl: string, sessionId: string) =>
  queryOptions({
    queryKey: queryKeys.opencode.todos(baseUrl, sessionId),
    queryFn: () => fetchOpenCodeTodos(baseUrl, sessionId),
    enabled: !!baseUrl && !!sessionId,
  });

export function useDeleteOpenCodeSession(baseUrl: string) {
  return useMutation({
    mutationKey: ["opencode", "deleteSession", baseUrl],
    mutationFn: (sessionId: string) =>
      deleteOpenCodeSession(baseUrl, sessionId),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.opencode.sessions(baseUrl),
      });
    },
  });
}
