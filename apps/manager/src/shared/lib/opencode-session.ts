import type { createOpencodeClient } from "@opencode-ai/sdk/v2";

type OpencodeClient = ReturnType<typeof createOpencodeClient>;

const DEFAULT_TIMEOUT_MS = 10_000;
const INITIAL_DELAY_MS = 25;
const MAX_DELAY_MS = 200;

/**
 * Poll `session.get` until the OpenCode session is readable.
 *
 * `POST /session/{id}/prompt_async` is fire-and-forget on the server: if the
 * session row is not yet visible when the prompt arrives, the handler logs the
 * error and silently drops the message while the client still sees 204. Callers
 * must ensure the session is queryable before sending the first prompt.
 */
export async function waitForOpencodeSessionReady(
  client: OpencodeClient,
  sessionID: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let delay = INITIAL_DELAY_MS;
  while (Date.now() < deadline) {
    try {
      const { data, error } = await client.session.get({ sessionID });
      if (data?.id && !error) return;
    } catch {
      // retry until deadline
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, MAX_DELAY_MS);
  }
  throw new Error(
    `OpenCode session ${sessionID} did not become ready in ${timeoutMs}ms`,
  );
}

export interface OpenedOpencodeSession {
  id: string;
  directory: string;
}

export interface OpenOpencodeSessionInput {
  title?: string;
  directory?: string;
}

/**
 * Create an OpenCode session and wait for it to be queryable.
 *
 * Wraps `session.create` + `waitForOpencodeSessionReady` as a single step so
 * callers can register listeners or send prompts safely afterwards.
 */
export async function openOpencodeSession(
  client: OpencodeClient,
  input: OpenOpencodeSessionInput = {},
): Promise<OpenedOpencodeSession> {
  const { data, error } = await client.session.create({
    ...(input.title && { title: input.title }),
    ...(input.directory && { directory: input.directory }),
  });
  if (error || !data?.id || !data?.directory) {
    throw new Error("Failed to create OpenCode session");
  }
  await waitForOpencodeSessionReady(client, data.id);
  return { id: data.id, directory: data.directory };
}

export interface StartOpencodeSessionInput extends OpenOpencodeSessionInput {
  prompt: string;
  model?: { providerID: string; modelID: string };
  variant?: string;
  agent?: string;
}

/**
 * Open a session and send its first prompt.
 *
 * Convenience wrapper around `openOpencodeSession` + `session.promptAsync` for
 * the common "create and kick off" flow. Use `openOpencodeSession` directly
 * when you need to run logic (e.g. register event listeners) between session
 * creation and the prompt.
 */
export async function startOpencodeSession(
  client: OpencodeClient,
  input: StartOpencodeSessionInput,
): Promise<OpenedOpencodeSession> {
  const session = await openOpencodeSession(client, {
    title: input.title,
    directory: input.directory,
  });
  const { error } = await client.session.promptAsync({
    sessionID: session.id,
    parts: [{ type: "text", text: input.prompt }],
    ...(input.model && { model: input.model }),
    ...(input.variant && { variant: input.variant }),
    ...(input.agent && { agent: input.agent }),
  });
  if (error) {
    throw new Error("Failed to send prompt to OpenCode session");
  }
  return session;
}
