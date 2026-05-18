import type { createOpencodeClient } from "@opencode-ai/sdk/v2";
import type { SandboxWarning } from "../../schemas/index.ts";
import { createChildLogger } from "./logger.ts";

type OpencodeClient = ReturnType<typeof createOpencodeClient>;
type PromptParts = Parameters<OpencodeClient["session"]["promptAsync"]>[0];

const log = createChildLogger("opencode-session");

const DEFAULT_READY_TIMEOUT_MS = 10_000;
const READY_INITIAL_DELAY_MS = 25;
const READY_MAX_DELAY_MS = 200;

const VERIFY_TIMEOUT_MS = 5_000;
const VERIFY_INITIAL_DELAY_MS = 50;
const VERIFY_MAX_DELAY_MS = 400;
const DEFAULT_PROMPT_RETRIES = 1;

const AGENT_REGISTRY_TIMEOUT_MS = 120_000;
const AGENT_REGISTRY_INITIAL_DELAY_MS = 100;
const AGENT_REGISTRY_MAX_DELAY_MS = 500;

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
  timeoutMs: number = DEFAULT_READY_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let delay = READY_INITIAL_DELAY_MS;
  while (Date.now() < deadline) {
    try {
      const { data, error } = await client.session.get({ sessionID });
      if (data?.id && !error) return;
    } catch {
      // retry until deadline
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, READY_MAX_DELAY_MS);
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
 * Block until OpenCode's agent registry is loaded.
 *
 * Spawn workflows now wait only for HTTP healthy, so the registry wait
 * shifts here — paid lazily by the first session creator on a fresh
 * sandbox. Without this, `session.create` succeeds but the subsequent
 * `session.promptAsync` is silently dropped if the registry isn't ready.
 * Cheap once loaded: `app.agents` is an in-memory hash lookup.
 */
export async function waitForOpencodeAgentRegistry(
  client: OpencodeClient,
  timeoutMs: number = AGENT_REGISTRY_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let delay = AGENT_REGISTRY_INITIAL_DELAY_MS;
  while (Date.now() < deadline) {
    try {
      const { data, error } = await client.app.agents();
      if (data && !error) return;
    } catch {
      // retry until deadline
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, AGENT_REGISTRY_MAX_DELAY_MS);
  }
  throw new Error(`OpenCode agent registry did not load in ${timeoutMs}ms`);
}

/**
 * Create an OpenCode session and wait for it to be queryable.
 *
 * Wraps `waitForOpencodeAgentRegistry` + `session.create` +
 * `waitForOpencodeSessionReady` as a single step so callers can register
 * listeners or send prompts safely afterwards.
 */
export async function openOpencodeSession(
  client: OpencodeClient,
  input: OpenOpencodeSessionInput = {},
): Promise<OpenedOpencodeSession> {
  // Ensure the agent registry is loaded before creating the session. The
  // session itself works without it, but the prompt path drops silently
  // if it isn't ready yet.
  await waitForOpencodeAgentRegistry(client);

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

export interface SendPromptInput {
  sessionID: string;
  parts: PromptParts["parts"];
  model?: { providerID: string; modelID: string };
  variant?: string;
  agent?: string;
}

export interface SendPromptOptions {
  /** Total time to wait for the user message to land before retrying. */
  verifyTimeoutMs?: number;
  /** Number of additional `promptAsync` attempts after the first. */
  retries?: number;
}

/**
 * Send a prompt and verify the server actually accepted it.
 *
 * `session.promptAsync` returns 204 immediately even when the server drops
 * the prompt (session not yet persisted, agent registry still booting,
 * provider config not loaded, etc.). We poll `session.messages` after sending
 * and retry once if no new user message lands within the verification window.
 *
 * Use this whenever the result of a prompt is observed only via SSE events or
 * by humans — i.e., the only safe alternative to `session.prompt` (which
 * blocks until the assistant finishes responding).
 */
export async function sendPromptAndVerify(
  client: OpencodeClient,
  input: SendPromptInput,
  options: SendPromptOptions = {},
): Promise<void> {
  const verifyTimeoutMs = options.verifyTimeoutMs ?? VERIFY_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_PROMPT_RETRIES;

  const baselineUserCount = await getUserMessageCount(client, input.sessionID);

  for (let attempt = 0; attempt <= retries; attempt++) {
    const { error } = await client.session.promptAsync({
      sessionID: input.sessionID,
      parts: input.parts,
      ...(input.model && { model: input.model }),
      ...(input.variant && { variant: input.variant }),
      ...(input.agent && { agent: input.agent }),
    });
    if (error) {
      throw new Error("Failed to send prompt to OpenCode session");
    }

    const arrived = await waitForUserMessage(
      client,
      input.sessionID,
      baselineUserCount + 1,
      verifyTimeoutMs,
    );
    if (arrived) {
      if (attempt > 0) {
        log.info(
          { sessionID: input.sessionID, attempt: attempt + 1 },
          "Prompt accepted after retry",
        );
      }
      return;
    }

    log.warn(
      { sessionID: input.sessionID, attempt: attempt + 1 },
      "Prompt was not picked up by OpenCode, retrying",
    );
  }

  throw new Error(
    `OpenCode dropped prompt for session ${input.sessionID} after ${retries + 1} attempts`,
  );
}

async function getUserMessageCount(
  client: OpencodeClient,
  sessionID: string,
): Promise<number> {
  try {
    const { data } = await client.session.messages({ sessionID });
    if (!data) return 0;
    return data.filter((m) => m.info.role === "user").length;
  } catch {
    return 0;
  }
}

async function waitForUserMessage(
  client: OpencodeClient,
  sessionID: string,
  expectedCount: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let delay = VERIFY_INITIAL_DELAY_MS;
  while (Date.now() < deadline) {
    const count = await getUserMessageCount(client, sessionID);
    if (count >= expectedCount) return true;
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, VERIFY_MAX_DELAY_MS);
  }
  return false;
}

export interface StartOpencodeSessionInput extends OpenOpencodeSessionInput {
  prompt: string;
  model?: { providerID: string; modelID: string };
  variant?: string;
  agent?: string;
}

/**
 * Open a session and send its first prompt with delivery verification.
 *
 * Convenience wrapper around `openOpencodeSession` + `sendPromptAndVerify` for
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
  await sendPromptAndVerify(client, {
    sessionID: session.id,
    parts: [{ type: "text", text: input.prompt }],
    model: input.model,
    variant: input.variant,
    agent: input.agent,
  });
  return session;
}

export interface ResolveAgentResult {
  /** The agent name to pass to `prompt`/`promptAsync`, or `undefined` to omit. */
  resolvedAgent?: string;
  /** Set when the requested agent was not in opencode's registry. */
  warning?: SandboxWarning;
}

/**
 * Validate that a requested agent exists in opencode's registry; degrade to
 * the server-side default if it doesn't.
 *
 * Returns:
 *   - `{}` when nothing was requested (caller wasn't going to set `agent`)
 *   - `{ resolvedAgent: requested }` when the agent exists
 *   - `{ warning }` when the agent is missing — the caller should record the
 *     warning on the sandbox and omit the `agent` field from the prompt, so
 *     opencode falls back to its default agent instead of silently dropping
 *     the prompt inside the forked `prompt_async` fiber.
 *
 * Costs one extra `GET /agent` round-trip per first prompt. Cheap; the
 * registry response is small and already cached by opencode by the time
 * `waitForOpencodeAgentRegistry` returned.
 */
export async function resolveAgent(
  client: OpencodeClient,
  requested: string | undefined,
): Promise<ResolveAgentResult> {
  if (!requested) return {};

  let available: string[] = [];
  try {
    const { data, error } = await client.app.agents();
    if (error || !data) {
      // Registry unreachable — don't synthesise a misleading warning,
      // just let the caller proceed with the requested agent and let the
      // existing `sendPromptAndVerify` retry surface the real failure.
      return { resolvedAgent: requested };
    }
    available = data.map((a) => a.name);
  } catch {
    return { resolvedAgent: requested };
  }

  if (available.includes(requested)) {
    return { resolvedAgent: requested };
  }

  log.warn(
    { requested, available },
    "Requested agent not in opencode registry, falling back to default",
  );
  return {
    warning: {
      code: "agent_not_found",
      message: `Configured agent "${requested}" is not available on this opencode binary. Prompt sent without the \`agent\` field; opencode will use its default agent.`,
      context: {
        requested,
        available,
      },
      createdAt: new Date().toISOString(),
    },
  };
}
