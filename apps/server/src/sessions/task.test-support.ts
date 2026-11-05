/**
 * Test support: a stubbed `AgentDispatch` for `AgentTaskService` tests (no ACP,
 * no sandbox). The fake hands back a controllable session handle and lets a
 * test stream `session/update` notifications into the service. The real ACP
 * wiring (incl. auto-approved permission requests) is covered by
 * `acp/agent-dispatch.test.ts`.
 */
import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { OpenAgentSessionInput } from "./acp/agent-dispatch.ts";
import type { AgentTaskServiceDeps } from "./task.service.ts";

export const OWNER = "user-1";
export const SANDBOX = "sbx-1";
export const SESSION = "sess-1";

interface PendingPrompt {
  text: string;
  resolve: (stopReason: string) => void;
  reject: (err: Error) => void;
}

export function makeFake(
  opts: {
    status?: string;
    annotations?: Record<string, string> | undefined;
  } = {},
) {
  const prompts: PendingPrompt[] = [];
  const opened: OpenAgentSessionInput[] = [];
  /** `connection` counts drops: a handle is live while it matches.
   * `unseenRestart`: the acp process restarted and only `stillLive` (which
   * asks the agent) finds out. */
  const state = {
    cancelled: 0,
    closed: 0,
    nextSession: 1,
    connection: 0,
    unseenRestart: false,
    stillLiveCalls: 0,
    status: opts.status ?? "running",
  };
  let onUpdate: ((n: SessionNotification) => void) | undefined;

  const handleFor = (sessionId: string, connection = state.connection) => ({
    sessionId,
    sandboxId: SANDBOX,
    get live() {
      return connection === state.connection;
    },
    stillLive: async () => {
      state.stillLiveCalls++;
      if (state.unseenRestart) {
        state.unseenRestart = false;
        state.connection++;
      }
      return connection === state.connection;
    },
    prompt: (text: string) =>
      new Promise<{ stopReason: string }>((resolve, reject) => {
        prompts.push({
          text,
          resolve: (stopReason) => resolve({ stopReason }),
          reject,
        });
      }),
    cancel: async () => {
      state.cancelled++;
      // A cooperative agent ends the in-flight turn as `cancelled`.
      prompts.at(-1)?.resolve("cancelled");
    },
    close: async () => {
      state.closed++;
    },
  });

  const deps: AgentTaskServiceDeps = {
    runtime: {
      getStatus: () => state.status,
      getLabels: () => ({
        metadata: {},
        annotations:
          ("annotations" in opts
            ? opts.annotations
            : { "atelier.dev/harness": "opencode" }) ?? {},
      }),
    } as unknown as AgentTaskServiceDeps["runtime"],
    dispatch: {
      openSession: async (input: OpenAgentSessionInput) => {
        opened.push(input);
        onUpdate = input.callbacks?.onUpdate;
        if (input.resumeSessionId) return handleFor(input.resumeSessionId);
        const id = state.nextSession++;
        return handleFor(id === 1 ? SESSION : `${SESSION}-${id}`);
      },
      todosFor: async () => [],
    } as unknown as AgentTaskServiceDeps["dispatch"],
  };

  return {
    deps,
    opened,
    prompts,
    state,
    /** Stream an agent text chunk into the service. */
    say(text: string, messageId?: string, sessionId = SESSION) {
      onUpdate?.({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
          ...(messageId && { messageId }),
        },
      } as SessionNotification);
    },
    toolCall(id: string, title: string, status?: string) {
      onUpdate?.({
        sessionId: SESSION,
        update: { sessionUpdate: "tool_call", toolCallId: id, title, status },
      } as SessionNotification);
    },
    toolCallDone(id: string) {
      onUpdate?.({
        sessionId: SESSION,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: id,
          status: "completed",
        },
      } as SessionNotification);
    },
    /** Finish the oldest in-flight turn. */
    finish(stopReason = "end_turn") {
      prompts.shift()?.resolve(stopReason);
    },
    /** The ACP connection drops (acp restart, sandbox paused): every handle
     * opened so far stops being live. */
    dropConnection() {
      state.connection++;
    },
    /** The acp process restarts without the connection noticing: handles
     * look live until `stillLive` asks the agent. */
    restartAgentUnseen() {
      state.unseenRestart = true;
    },
  };
}
