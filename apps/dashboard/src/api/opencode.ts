import { createOpencodeClient, type Session } from "@opencode-ai/sdk/v2";

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
  directory?: string,
): Promise<{ success: true } | { error: string }> {
  try {
    const client = createOpencodeClient({ baseUrl });
    const result = await client.session.promptAsync({
      sessionID: sessionId,
      directory,
      parts: [{ type: "text", text: message }],
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
