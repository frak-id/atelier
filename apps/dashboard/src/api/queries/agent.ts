import { queryOptions, useMutation } from "@tanstack/react-query";
import {
  abortSession,
  deleteAgentSession,
  fetchAgentPermissions,
  fetchAgentQuestions,
  fetchAgentSessions,
  fetchAgentTodos,
  getAgentSessionStatuses,
  rejectQuestion,
  replyPermission,
  replyQuestion,
} from "../agent";
import { queryKeys } from "./keys";

export const agentSessionsQuery = (sandboxId: string) =>
  queryOptions({
    queryKey: queryKeys.agent.sessions(sandboxId),
    queryFn: () => fetchAgentSessions(sandboxId),
    enabled: !!sandboxId,
  });

export const agentPermissionsQuery = (sandboxId: string) =>
  queryOptions({
    queryKey: queryKeys.agent.permissions(sandboxId),
    queryFn: () => fetchAgentPermissions(sandboxId),
    enabled: !!sandboxId,
  });

export const agentQuestionsQuery = (sandboxId: string) =>
  queryOptions({
    queryKey: queryKeys.agent.questions(sandboxId),
    queryFn: () => fetchAgentQuestions(sandboxId),
    enabled: !!sandboxId,
  });

export const agentSessionStatusesQuery = (sandboxId: string) =>
  queryOptions({
    queryKey: queryKeys.agent.sessionStatuses(sandboxId),
    queryFn: () => getAgentSessionStatuses(sandboxId),
    enabled: !!sandboxId,
  });

export const agentTodosQuery = (sandboxId: string, sessionId: string) =>
  queryOptions({
    queryKey: queryKeys.agent.todos(sandboxId, sessionId),
    queryFn: () => fetchAgentTodos(sandboxId, sessionId),
    enabled: !!sandboxId && !!sessionId,
  });

export function useDeleteAgentSession(sandboxId: string) {
  return useMutation({
    mutationKey: ["agent", "deleteSession", sandboxId],
    mutationFn: (sessionId: string) => deleteAgentSession(sandboxId, sessionId),
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
