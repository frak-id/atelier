import {
  createOpencodeClient,
  type PermissionRequest,
  type QuestionRequest,
  type Session,
  type Todo,
} from "@opencode-ai/sdk/v2";

export type SessionStatus =
  | { type: "idle" }
  | { type: "retry"; attempt: number; message: string; next: number }
  | { type: "busy" };

export async function fetchOpenCodeSessions(
  baseUrl: string,
): Promise<Session[]> {
  try {
    const client = createOpencodeClient({
      baseUrl,
    });
    const { data } = await client.session.list();
    return data ?? [];
  } catch {
    return [];
  }
}

export async function deleteOpenCodeSession(
  baseUrl: string,
  sessionId: string,
): Promise<boolean> {
  try {
    const client = createOpencodeClient({
      baseUrl,
    });
    const result = await client.session.delete({ sessionID: sessionId });
    return result.data ?? false;
  } catch {
    return false;
  }
}

export async function createOpenCodeSession(
  baseUrl: string,
  directory?: string,
): Promise<{ sessionId: string; directory: string } | { error: string }> {
  try {
    const client = createOpencodeClient({ baseUrl });
    const { data, error } = await client.session.create({ directory });
    if (error || !data?.id || !data?.directory) {
      return { error: "Failed to create session" };
    }
    return { sessionId: data.id, directory: data.directory };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export interface TemplateConfig {
  model?: { providerID: string; modelID: string };
  variant?: string;
  agent?: string;
}

export async function sendOpenCodeMessage(
  baseUrl: string,
  sessionId: string,
  message: string,
  options?: { directory?: string; templateConfig?: TemplateConfig },
): Promise<{ success: true } | { error: string }> {
  try {
    const client = createOpencodeClient({ baseUrl });

    const result = await client.session.promptAsync({
      sessionID: sessionId,
      directory: options?.directory,
      parts: [{ type: "text", text: message }],
      ...(options?.templateConfig && {
        model: options.templateConfig.model,
        variant: options.templateConfig.variant,
        agent: options.templateConfig.agent,
      }),
    });
    if (result.error) {
      return { error: "Failed to send message" };
    }
    return { success: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export async function checkOpenCodeHealth(baseUrl: string): Promise<boolean> {
  try {
    const client = createOpencodeClient({ baseUrl });
    const { data } = await client.global.health();
    return data?.healthy ?? false;
  } catch {
    return false;
  }
}

export async function getOpenCodeSessionStatuses(
  baseUrl: string,
): Promise<Record<string, SessionStatus>> {
  try {
    const client = createOpencodeClient({ baseUrl });
    const { data } = await client.session.status();
    return (data as Record<string, SessionStatus>) ?? {};
  } catch {
    return {};
  }
}

export async function fetchOpenCodePermissions(
  baseUrl: string,
): Promise<PermissionRequest[]> {
  try {
    const client = createOpencodeClient({ baseUrl });
    const { data } = await client.permission.list();
    return data ?? [];
  } catch {
    return [];
  }
}

export async function fetchOpenCodeQuestions(
  baseUrl: string,
): Promise<QuestionRequest[]> {
  try {
    const client = createOpencodeClient({ baseUrl });
    const { data } = await client.question.list();
    return data ?? [];
  } catch {
    return [];
  }
}

export async function fetchOpenCodeTodos(
  baseUrl: string,
  sessionId: string,
): Promise<Todo[]> {
  try {
    const client = createOpencodeClient({ baseUrl });
    const { data } = await client.session.todo({ sessionID: sessionId });
    return data ?? [];
  } catch {
    return [];
  }
}

export type { PermissionRequest, QuestionRequest, Todo };
