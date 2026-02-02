import { queryOptions, useMutation } from "@tanstack/react-query";
import {
  abortSession,
  deleteOpenCodeSession,
  fetchOpenCodePermissions,
  fetchOpenCodeQuestions,
  fetchOpenCodeSessions,
  fetchOpenCodeTodos,
  getOpenCodeSessionStatuses,
  rejectQuestion,
  replyPermission,
  replyQuestion,
} from "../opencode";
import { queryKeys } from "./keys";

export const opencodeSessionsQuery = (baseUrl: string) =>
  queryOptions({
    queryKey: queryKeys.opencode.sessions(baseUrl),
    queryFn: () => fetchOpenCodeSessions(baseUrl),
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

export function useReplyPermission(baseUrl: string) {
  return useMutation({
    mutationKey: ["opencode", "replyPermission", baseUrl],
    mutationFn: ({
      requestID,
      reply,
    }: {
      requestID: string;
      reply: "once" | "reject";
    }) => replyPermission(baseUrl, requestID, reply),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.opencode.permissions(baseUrl),
      });
    },
  });
}

export function useReplyQuestion(baseUrl: string) {
  return useMutation({
    mutationKey: ["opencode", "replyQuestion", baseUrl],
    mutationFn: ({
      requestID,
      answers,
    }: {
      requestID: string;
      answers: Array<Array<string>>;
    }) => replyQuestion(baseUrl, requestID, answers),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.opencode.questions(baseUrl),
      });
    },
  });
}

export function useRejectQuestion(baseUrl: string) {
  return useMutation({
    mutationKey: ["opencode", "rejectQuestion", baseUrl],
    mutationFn: (requestID: string) => rejectQuestion(baseUrl, requestID),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.opencode.questions(baseUrl),
      });
    },
  });
}

export function useAbortSession(baseUrl: string) {
  return useMutation({
    mutationKey: ["opencode", "abortSession", baseUrl],
    mutationFn: (sessionID: string) => abortSession(baseUrl, sessionID),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.opencode.sessions(baseUrl),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.opencode.sessionStatuses(baseUrl),
      });
    },
  });
}
