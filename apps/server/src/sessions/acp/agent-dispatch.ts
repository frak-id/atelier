/**
 * Agent-neutral ACP client. Reshaped from v1 `shared/agent/agent-dispatch.ts`:
 * `AgentClient` now comes from `runtime/` (the seam), and harness dispatch
 * goes through the neutral `harness-registry.ts` instead of the old
 * `resolveHarness()`. Fully harness-neutral otherwise — this is the
 * manager-side ACP client that spawns a harness via the in-pod bridge and
 * speaks ACP over the WebSocket relay (atelier-v2 §3.1 "sessions/").
 */
import {
  type ClientConnection,
  client,
  type McpServer,
  methods,
  PROTOCOL_VERSION,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import type { AgentClient } from "../../runtime/index.ts";
import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import { connectAcpWebSocket } from "./acp-stream.ts";
import {
  type AgentModelSelection,
  type HarnessDispatchAdapter,
  resolveHarnessDispatch,
} from "./harness-registry.ts";

const log = createChildLogger("agent-dispatch");

/** See v1 rationale: bounds handshake calls only, never `session/prompt`. */
const ACP_HANDSHAKE_TIMEOUT_MS = 30_000;

export interface AgentSessionCallbacks {
  onUpdate?: (notification: SessionNotification) => void;
  onPermission?: (
    request: RequestPermissionRequest,
  ) => Promise<RequestPermissionResponse>;
}

export interface OpenAgentSessionInput {
  sandboxId: string;
  /** Absolute working directory for the session. */
  cwd: string;
  /** The already-running acp process's launch command (spec-composed). */
  acpCommand: string;
  /** Harness dispatch id, from the spec's `atelier.dev/harness` annotation. */
  harnessId?: string;
  mcpServers?: McpServer[];
  callbacks?: AgentSessionCallbacks;
}

export interface AgentSession {
  readonly sessionId: string;
  readonly bridgeSessionId: string;
  readonly sandboxId: string;
  prompt(
    text: string,
    selection?: AgentModelSelection,
  ): Promise<PromptResponse>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}

async function withTimeout<T>(
  op: Promise<T>,
  ms: number,
  connection: ClientConnection,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`ACP ${label} timed out after ${ms}ms`);
      connection.close(err);
      reject(err);
    }, ms);
  });
  try {
    return await Promise.race([op, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export class AgentDispatch {
  private readonly sessions = new Map<string, AgentSession>();

  constructor(private readonly deps: { agentClient: AgentClient }) {}

  getSession(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  async openSession(input: OpenAgentSessionInput): Promise<AgentSession> {
    const harness: HarnessDispatchAdapter = resolveHarnessDispatch(
      input.harnessId,
    );
    const callbacks = input.callbacks ?? {};

    const bridge = await this.deps.agentClient.acpSessionCreate(
      input.sandboxId,
      { command: input.acpCommand, workdir: input.cwd, user: "dev" },
    );

    const url = await this.deps.agentClient.acpWebSocketUrl(
      input.sandboxId,
      bridge.id,
      config.ports.acp,
    );
    const transport = connectAcpWebSocket(url);

    const connection = client({ name: "atelier-server" })
      .onNotification(methods.client.session.update, (ctx) => {
        callbacks.onUpdate?.(ctx.params);
      })
      .onRequest(methods.client.session.requestPermission, async (ctx) => {
        if (callbacks.onPermission) return callbacks.onPermission(ctx.params);
        log.warn(
          { sessionId: ctx.params.sessionId },
          "No permission handler registered; cancelling permission request",
        );
        return { outcome: { outcome: "cancelled" } };
      })
      .connect(transport.stream);

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
      const acp = connection.agent;
      await withTimeout(
        acp.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        }),
        ACP_HANDSHAKE_TIMEOUT_MS,
        connection,
        "initialize",
      );
      const created = await withTimeout(
        acp.request(methods.agent.session.new, {
          cwd: input.cwd,
          mcpServers: input.mcpServers ?? [],
        }),
        ACP_HANDSHAKE_TIMEOUT_MS,
        connection,
        "session/new",
      );

      const session: AgentSession = {
        sessionId: created.sessionId,
        bridgeSessionId: bridge.id,
        sandboxId: input.sandboxId,
        prompt: async (text, selection) => {
          const assignments = selection
            ? (harness.sessionConfig?.(selection) ?? [])
            : [];
          for (const { configId, value } of assignments) {
            await withTimeout(
              acp.request(methods.agent.session.setConfigOption, {
                sessionId: created.sessionId,
                configId,
                value,
              }),
              ACP_HANDSHAKE_TIMEOUT_MS,
              connection,
              "session/set_config_option",
            );
          }
          return acp.request(methods.agent.session.prompt, {
            sessionId: created.sessionId,
            prompt: [{ type: "text", text }],
          });
        },
        cancel: () =>
          acp.notify(methods.agent.session.cancel, {
            sessionId: created.sessionId,
          }),
        close: async () => {
          if (this.sessions.delete(created.sessionId)) {
            connection.close();
            await teardownBridge();
          }
        },
      };

      this.sessions.set(created.sessionId, session);

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
      connection.close(err);
      await teardownBridge();
      throw err;
    }
  }

  async closeAll(sandboxId?: string): Promise<void> {
    const targets = [...this.sessions.values()].filter(
      (s) => !sandboxId || s.sandboxId === sandboxId,
    );
    await Promise.allSettled(targets.map((s) => s.close()));
  }
}
