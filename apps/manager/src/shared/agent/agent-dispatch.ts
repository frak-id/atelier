import {
  type Client,
  ClientSideConnection,
  type McpServer,
  PROTOCOL_VERSION,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { VM } from "@frak/atelier-shared/constants";
import type { AgentClient } from "../../infrastructure/agent/index.ts";
import { config } from "../lib/config.ts";
import { createChildLogger } from "../lib/logger.ts";
import { connectAcpWebSocket } from "./acp-stream.ts";
import {
  type AgentModelSelection,
  type HarnessAdapter,
  resolveHarness,
} from "./harness-adapter.ts";

const log = createChildLogger("agent-dispatch");

export interface AgentSessionCallbacks {
  /** Fired for every ACP `session/update` (plan, message chunk, tool call, …). */
  onUpdate?: (notification: SessionNotification) => void;
  /**
   * Answer an ACP `session/request_permission`. If omitted the request is
   * cancelled (never silently approved), so a headless run can't auto-authorize
   * a sensitive tool call.
   */
  onPermission?: (
    request: RequestPermissionRequest,
  ) => Promise<RequestPermissionResponse>;
}

export interface OpenAgentSessionInput {
  sandboxId: string;
  /** Absolute working directory for the session; defaults to the VM home. */
  cwd?: string;
  /** MCP servers injected into `session/new`. */
  mcpServers?: McpServer[];
  callbacks?: AgentSessionCallbacks;
}

/** A live ACP session: the manager holds the connection for its whole lifetime. */
export interface AgentSession {
  /** ACP session id returned by `session/new`. */
  readonly sessionId: string;
  /** In-pod bridge subprocess id from `POST /acp/sessions`. */
  readonly bridgeSessionId: string;
  readonly sandboxId: string;
  /** Send a prompt; resolves with the turn's stop reason. */
  prompt(
    text: string,
    selection?: AgentModelSelection,
  ): Promise<PromptResponse>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}

class DispatchClient implements Client {
  constructor(private readonly callbacks: AgentSessionCallbacks) {}

  sessionUpdate(notification: SessionNotification): void {
    this.callbacks.onUpdate?.(notification);
  }

  async requestPermission(
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    if (this.callbacks.onPermission) {
      return this.callbacks.onPermission(request);
    }
    log.warn(
      { sessionId: request.sessionId },
      "No permission handler registered; cancelling permission request",
    );
    return { outcome: { outcome: "cancelled" } };
  }
}

/**
 * Agent-neutral ACP client. Replaces the OpenCode SDK surface: it spawns a
 * harness via the in-pod ACP bridge, speaks ACP over the WebSocket relay, and
 * keeps every opened session live in an in-memory registry (the manager is the
 * single ACP client — see the facade design in the ACP plan).
 */
export class AgentDispatch {
  private readonly sessions = new Map<string, AgentSession>();

  constructor(
    private readonly deps: {
      agentClient: AgentClient;
      /** Harness to launch; defaults to the configured default (opencode). */
      harness?: HarnessAdapter;
    },
  ) {}

  /** Look up a live session by its ACP session id. */
  getSession(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  async openSession(input: OpenAgentSessionInput): Promise<AgentSession> {
    const harness = this.deps.harness ?? resolveHarness(undefined);
    const cwd = input.cwd ?? VM.HOME;

    const bridge = await this.deps.agentClient.acpSessionCreate(
      input.sandboxId,
      { command: harness.acpCommand(), workdir: cwd, user: "dev" },
    );

    const url = await this.deps.agentClient.acpWebSocketUrl(
      input.sandboxId,
      bridge.id,
      config.ports.acp,
    );
    const transport = connectAcpWebSocket(url);
    const client = new DispatchClient(input.callbacks ?? {});
    const connection = new ClientSideConnection(() => client, transport.stream);

    const teardownBridge = async () => {
      transport.close();
      await this.deps.agentClient
        .acpSessionDelete(input.sandboxId, bridge.id)
        .catch((err) =>
          log.warn(
            { sandboxId: input.sandboxId, bridgeSessionId: bridge.id, err },
            "Failed to delete ACP bridge session",
          ),
        );
    };

    try {
      await transport.ready;
      await connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const created = await connection.newSession({
        cwd,
        mcpServers: input.mcpServers ?? [],
      });

      const session: AgentSession = {
        sessionId: created.sessionId,
        bridgeSessionId: bridge.id,
        sandboxId: input.sandboxId,
        prompt: async (text, selection) => {
          // Model/agent selection is session-scoped in ACP: apply it via
          // set_config_option before the turn (opencode ignores prompt _meta).
          // Idempotent, so re-sending the same selection each prompt is fine
          // and also supports switching model mid-session.
          const assignments = selection
            ? (harness.sessionConfig?.(selection) ?? [])
            : [];
          for (const { configId, value } of assignments) {
            await connection.setSessionConfigOption({
              sessionId: created.sessionId,
              configId,
              value,
            });
          }
          return connection.prompt({
            sessionId: created.sessionId,
            prompt: [{ type: "text", text }],
          });
        },
        cancel: () => connection.cancel({ sessionId: created.sessionId }),
        close: async () => {
          if (this.sessions.delete(created.sessionId)) {
            await teardownBridge();
          }
        },
      };

      this.sessions.set(created.sessionId, session);

      // If the connection drops (bridge crash, pod eviction, harness exit),
      // evict the now-dead session and tear down the pod-side bridge process.
      // Guarded by the atomic Map delete so it runs exactly once, whether the
      // trigger is this observer or an explicit close().
      void connection.closed.finally(() => {
        if (this.sessions.delete(created.sessionId)) {
          void teardownBridge();
        }
      });

      log.info(
        {
          sandboxId: input.sandboxId,
          sessionId: created.sessionId,
          harness: harness.id,
        },
        "ACP session opened",
      );
      return session;
    } catch (err) {
      await teardownBridge();
      throw err;
    }
  }

  /** Close every live session (e.g. on sandbox teardown). */
  async closeAll(sandboxId?: string): Promise<void> {
    const targets = [...this.sessions.values()].filter(
      (s) => !sandboxId || s.sandboxId === sandboxId,
    );
    await Promise.allSettled(targets.map((s) => s.close()));
  }
}
