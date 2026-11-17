/**
 * Atelier's sandbox MCP (`/mcp`), over its Streamable HTTP transport: JSON-RPC
 * posts in one session, each answered with JSON or a server-sent event stream.
 * The server keeps sessions in memory: after a restart it answers an old one
 * 404, the transport's cue to start a new session.
 */

const PROTOCOL_VERSION = "2025-06-18";
/** Tools that only read, so safe to send again after a network error or a
 * server error. */
const READ_ONLY_TOOLS = new Set([
  "whoami",
  "get_sandbox",
  "get_task",
  "read_files",
]);
/** Waits before each retry of a read-only call: a 40-minute review shouldn't
 * die of one dropped connection. */
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000];

interface JsonRpcResponse {
  id?: number;
  result?: {
    content?: { type: string; text?: string }[];
    structuredContent?: unknown;
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

export class Atelier {
  private sessionId: string | undefined;
  private nextId = 1;

  constructor(
    private readonly url: string,
    private readonly apiKey: string,
  ) {}

  /** Calls a tool and returns its result's data; a tool error (`isError`)
   * throws with its message. */
  async call<T>(tool: string, args: Record<string, unknown>): Promise<T> {
    const response = await this.requestWithRetries(tool, args);
    const { result, error } = response;
    if (error) throw new Error(`${tool}: ${error.message}`);
    const text = result?.content?.find((c) => c.type === "text")?.text ?? "";
    if (result?.isError) throw new Error(`${tool}: ${text}`);
    return (result?.structuredContent ?? JSON.parse(text)) as T;
  }

  private async requestWithRetries(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<JsonRpcResponse> {
    const delays = READ_ONLY_TOOLS.has(tool) ? RETRY_DELAYS_MS : [];
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.request("tools/call", {
          name: tool,
          arguments: args,
        });
      } catch (error) {
        const delay = delays[attempt];
        // A refusal (4xx) won't change; a network error, a timeout or a 5xx
        // may.
        if (delay === undefined || error instanceof RefusedError) throw error;
        console.log(
          `[agent-review] ${tool} failed (${(error as Error).message}), retrying in ${delay / 1000} s`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  private async request(
    method: string,
    params: unknown,
    retried = false,
  ): Promise<JsonRpcResponse> {
    if (!this.sessionId) await this.initialize();
    const id = this.nextId++;
    const response = await this.post({ jsonrpc: "2.0", id, method, params });
    if (response.status === 404 && !retried) {
      this.sessionId = undefined;
      return this.request(method, params, true);
    }
    if (!response.ok) {
      const message = `${method}: HTTP ${response.status}: ${await response.text()}`;
      throw response.status < 500
        ? new RefusedError(message)
        : new Error(message);
    }
    return readMessage(response, id);
  }

  private async initialize(): Promise<void> {
    const id = this.nextId++;
    const response = await this.post({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "agent-review", version: "1" },
      },
    });
    if (!response.ok) {
      const message = `initialize: HTTP ${response.status}: ${await response.text()}`;
      throw response.status < 500
        ? new RefusedError(message)
        : new Error(message);
    }
    this.sessionId = response.headers.get("mcp-session-id") ?? undefined;
    try {
      const message = await readMessage(response, id);
      if (message.error)
        throw new Error(`initialize: ${message.error.message}`);
      const initialized = await this.post({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });
      if (!initialized.ok)
        throw new Error(
          `notifications/initialized: HTTP ${initialized.status}`,
        );
    } catch (error) {
      // A session whose handshake didn't finish isn't one: the next call starts
      // over.
      this.sessionId = undefined;
      throw error;
    }
  }

  private post(message: unknown): Promise<Response> {
    return fetch(this.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": PROTOCOL_VERSION,
        ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
      },
      body: JSON.stringify(message),
      // Above the 50 s a tool can block for (`waitSeconds`).
      signal: AbortSignal.timeout(120_000),
    });
  }
}

/** The server refused the request (4xx): sending it again won't help. */
class RefusedError extends Error {}

/** The response to request `id`: the body itself, or the matching message of
 * its event stream. */
async function readMessage(
  response: Response,
  id: number,
): Promise<JsonRpcResponse> {
  const body = await response.text();
  if (!response.headers.get("content-type")?.includes("text/event-stream"))
    return JSON.parse(body);
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    const message = JSON.parse(data) as JsonRpcResponse;
    if (message.id === id) return message;
  }
  throw new Error(`no response to request ${id} in the event stream`);
}
