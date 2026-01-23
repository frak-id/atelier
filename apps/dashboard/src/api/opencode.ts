import type { TaskEffort } from "@frak-sandbox/manager/types";
import { createOpencodeClient, type Session } from "@opencode-ai/sdk/v2";

const EFFORT_CONFIG: Record<
  TaskEffort,
  {
    model: { providerID: string; modelID: string };
    variant: string;
    agent: string;
  }
> = {
  low: {
    model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
    variant: "high",
    agent: "Sisyphus",
  },
  medium: {
    model: { providerID: "anthropic", modelID: "claude-opus-4-5" },
    variant: "high",
    agent: "Sisyphus",
  },
  high: {
    model: { providerID: "anthropic", modelID: "claude-opus-4-5" },
    variant: "max",
    agent: "Sisyphus",
  },
  maximum: {
    model: { providerID: "anthropic", modelID: "claude-opus-4-5" },
    variant: "max",
    agent: "Planner-Sisyphus",
  },
};

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

export async function sendOpenCodeMessage(
  baseUrl: string,
  sessionId: string,
  message: string,
  options?: { directory?: string; effort?: TaskEffort },
): Promise<{ success: true } | { error: string }> {
  try {
    const client = createOpencodeClient({ baseUrl });
    const config = options?.effort ? EFFORT_CONFIG[options.effort] : undefined;

    const result = await client.session.promptAsync({
      sessionID: sessionId,
      directory: options?.directory,
      parts: [{ type: "text", text: message }],
      ...(config && {
        model: config.model,
        variant: config.variant,
        agent: config.agent,
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
