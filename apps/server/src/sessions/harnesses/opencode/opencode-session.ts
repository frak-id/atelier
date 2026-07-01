import type { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { createChildLogger } from "../../../shared/lib/logger.ts";

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

/** A degrade-to-default signal surfaced when a requested agent is unknown. */
export interface OpencodeWarning {
  code: "agent_not_found";
  message: string;
  context: Record<string, unknown>;
  createdAt: string;
}

/**
 * Poll `session.get` until the OpenCode session is readable.
 *
 * `POST /session/{id}/prompt_async` is fire-and-forget on the server: if the
 * session row is not yet visible when the prompt arrives, the handler logs
 * the error and silently drops the message while the client still sees 204.
 * Callers must ensure the session is queryable before sending the first
 * prompt. Ported verbatim from v1 `shared/lib/opencode-session.ts`.
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
 * Block until OpenCode's agent registry is loaded. Spawn workflows wait only
 * for HTTP healthy, so the registry wait shifts here — paid lazily by the
 * first session creator on a fresh sandbox.
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
 * Create an OpenCode session and wait for it to be queryable. Wraps
 * `waitForOpencodeAgentRegistry` + `session.create` +
 * `waitForOpencodeSessionReady` as a single step.
 */
export async function openOpencodeSession(
  client: OpencodeClient,
  input: OpenOpencodeSessionInput = {},
): Promise<OpenedOpencodeSession> {
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
  verifyTimeoutMs?: number;
  retries?: number;
}

/**
 * Send a prompt and verify the server actually accepted it (opencode's
 * `session.promptAsync` returns 204 even when it silently drops the prompt).
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

export interface ResolveAgentResult {
  resolvedAgent?: string;
  warning?: OpencodeWarning;
}

/**
 * Validate that a requested agent exists in opencode's registry; degrade to
 * the server-side default if it doesn't.
 */
export async function resolveAgent(
  client: OpencodeClient,
  requested: string | undefined,
): Promise<ResolveAgentResult> {
  if (!requested) return {};

  let available: string[] = [];
  try {
    const { data, error } = await client.app.agents();
    if (error || !data) return { resolvedAgent: requested };
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
      context: { requested, available },
      createdAt: new Date().toISOString(),
    },
  };
}
