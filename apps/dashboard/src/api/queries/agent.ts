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
} from "../agent";
import { queryKeys } from "./keys";

export const opencodeSessionsQuery = (sandboxId: string) =>
  queryOptions({
    queryKey: queryKeys.agent.sessions(sandboxId),
    queryFn: () => fetchOpenCodeSessions(sandboxId),
    enabled: !!sandboxId,
  });

export const opencodePermissionsQuery = (sandboxId: string) =>
  queryOptions({
    queryKey: queryKeys.agent.permissions(sandboxId),
    queryFn: () => fetchOpenCodePermissions(sandboxId),
    enabled: !!sandboxId,
  });

export const opencodeQuestionsQuery = (sandboxId: string) =>
  queryOptions({
    queryKey: queryKeys.agent.questions(sandboxId),
    queryFn: () => fetchOpenCodeQuestions(sandboxId),
    enabled: !!sandboxId,
  });

export const opencodeSessionStatusesQuery = (sandboxId: string) =>
  queryOptions({
    queryKey: queryKeys.agent.sessionStatuses(sandboxId),
    queryFn: () => getOpenCodeSessionStatuses(sandboxId),
    enabled: !!sandboxId,
  });

export const opencodeTodosQuery = (sandboxId: string, sessionId: string) =>
  queryOptions({
    queryKey: queryKeys.agent.todos(sandboxId, sessionId),
    queryFn: () => fetchOpenCodeTodos(sandboxId, sessionId),
    enabled: !!sandboxId && !!sessionId,
  });

export function useDeleteOpenCodeSession(sandboxId: string) {
  return useMutation({
    mutationKey: ["agent", "deleteSession", sandboxId],
    mutationFn: (sessionId: string) =>
      deleteOpenCodeSession(sandboxId, sessionId),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.agent.sessions(sandboxId),
      });
    },
  });
}

export function useReplyPermission(sandboxId: string) {
  return useMutation({
    mutationKey: ["agent", "replyPermission", sandboxId],
    mutationFn: ({
      requestID,
      reply,
    }: {
      requestID: string;
      reply: "once" | "always" | "reject";
    }) => replyPermission(sandboxId, requestID, reply),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.agent.permissions(sandboxId),
      });
    },
  });
}

export function useReplyQuestion(sandboxId: string) {
  return useMutation({
    mutationKey: ["agent", "replyQuestion", sandboxId],
    mutationFn: ({
      requestID,
      answers,
    }: {
      requestID: string;
      answers: Array<Array<string>>;
    }) => replyQuestion(sandboxId, requestID, answers),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.agent.questions(sandboxId),
      });
    },
  });
}

export function useRejectQuestion(sandboxId: string) {
  return useMutation({
    mutationKey: ["agent", "rejectQuestion", sandboxId],
    mutationFn: (requestID: string) => rejectQuestion(sandboxId, requestID),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.agent.questions(sandboxId),
      });
    },
  });
}

export function useAbortSession(sandboxId: string) {
  return useMutation({
    mutationKey: ["agent", "abortSession", sandboxId],
    mutationFn: (sessionID: string) => abortSession(sandboxId, sessionID),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.agent.sessions(sandboxId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.agent.sessionStatuses(sandboxId),
      });
    },
  });
}
