import { createOpencodeClient, Session } from "@opencode-ai/sdk/v2";

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
