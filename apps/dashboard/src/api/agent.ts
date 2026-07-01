import type {
  AgentPermissionRequest,
  AgentQuestionRequest,
  AgentSession,
  AgentSessionStatus,
  AgentTodo,
} from "@frak/atelier-shared";
import { api } from "@/api/client";

export type { AgentSessionStatus };
export type PermissionRequest = AgentPermissionRequest;
export type QuestionRequest = AgentQuestionRequest;
export type Todo = AgentTodo;

export interface TemplateConfig {
  model?: { providerID: string; modelID: string };
  variant?: string;
  agent?: string;
}

export async function fetchAgentSessions(
  sandboxId: string,
): Promise<AgentSession[]> {
  try {
    const { data } = await api.api
      .sandboxes({ id: sandboxId })
      .agent.sessions.get();
    return data ?? [];
  } catch {
    return [];
  }
}

export async function deleteAgentSession(
  sandboxId: string,
  sessionId: string,
): Promise<boolean> {
  try {
    const { data } = await api.api
      .sandboxes({ id: sandboxId })
      .agent.sessions({ sessionId })
      .delete();
    return data?.ok ?? false;
  } catch {
    return false;
  }
}

export async function createAgentSession(
  sandboxId: string,
  directory?: string,
): Promise<{ sessionId: string; directory: string } | { error: string }> {
  try {
    const { data, error } = await api.api
      .sandboxes({ id: sandboxId })
      .agent.sessions.post({ directory });
    if (error || !data || "error" in data) {
      return { error: "Failed to create session" };
    }
    return { sessionId: data.sessionId, directory: data.directory };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export async function getAgentSessionStatuses(
  sandboxId: string,
): Promise<Record<string, AgentSessionStatus>> {
  try {
    const { data } = await api.api
      .sandboxes({ id: sandboxId })
      .agent["session-statuses"].get();
    return data ?? {};
  } catch {
    return {};
  }
}

export async function fetchAgentPermissions(
  sandboxId: string,
): Promise<AgentPermissionRequest[]> {
  try {
    const { data } = await api.api
      .sandboxes({ id: sandboxId })
      .agent.permissions.get();
    return data ?? [];
  } catch {
    return [];
  }
}

export async function fetchAgentQuestions(
  sandboxId: string,
): Promise<AgentQuestionRequest[]> {
  try {
    const { data } = await api.api
      .sandboxes({ id: sandboxId })
      .agent.questions.get();
    return data ?? [];
  } catch {
    return [];
  }
}

export async function fetchAgentTodos(
  sandboxId: string,
  sessionId: string,
): Promise<AgentTodo[]> {
  try {
    const { data } = await api.api
      .sandboxes({ id: sandboxId })
      .agent.sessions({ sessionId })
      .todos.get();
    return data ?? [];
  } catch {
    return [];
  }
}

/**
 * Error thrown when a permission/question reply fails. Carries the upstream
 * HTTP `status` so callers can detect an expired request (404) via
 * `isInterventionExpired` instead of substring-matching the message.
 */
export class InterventionError extends Error {
  readonly status?: number;
  constructor(status: number | undefined, message: string) {
    super(message);
    this.name = "InterventionError";
    this.status = status;
  }
}

/** True when an intervention reply failed because the request had expired (404). */
export function isInterventionExpired(error: unknown): boolean {
  return error instanceof InterventionError && error.status === 404;
}

export async function replyPermission(
  sandboxId: string,
  requestId: string,
  reply: "once" | "always" | "reject",
): Promise<boolean> {
  const { data, error } = await api.api
    .sandboxes({ id: sandboxId })
    .agent.permissions({ requestId })
    .reply.post({ reply });
  if (error)
    throw new InterventionError(error.status, "Failed to reply to permission");
  return data?.ok ?? false;
}

export async function replyQuestion(
  sandboxId: string,
  requestId: string,
  answers: Array<Array<string>>,
): Promise<boolean> {
  const { data, error } = await api.api
    .sandboxes({ id: sandboxId })
    .agent.questions({ requestId })
    .reply.post({ answers });
  if (error)
    throw new InterventionError(error.status, "Failed to submit answer");
  return data?.ok ?? false;
}

export async function rejectQuestion(
  sandboxId: string,
  requestId: string,
): Promise<boolean> {
  const { data, error } = await api.api
    .sandboxes({ id: sandboxId })
    .agent.questions({ requestId })
    .reject.post();
  if (error)
    throw new InterventionError(error.status, "Failed to skip question");
  return data?.ok ?? false;
}

export async function abortSession(
  sandboxId: string,
  sessionId: string,
): Promise<boolean> {
  try {
    const { data } = await api.api
      .sandboxes({ id: sandboxId })
      .agent.sessions({ sessionId })
      .abort.post();
    return data?.ok ?? false;
  } catch {
    return false;
  }
}
