/**
 * Test support: a stubbed `AgentDispatch` for `AgentTaskService` tests (no ACP,
 * no sandbox). The fake hands back a controllable session handle, lets a test
 * stream `session/update` notifications into the service, and raises/answers
 * permission requests the way the real hub does (including its synchronous
 * `permissions` re-emit on reply). The real ACP wiring is covered by
 * `acp/agent-dispatch.test.ts`.
 */
import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { AgentPermissionRequest } from "@frak/atelier-shared";
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
  const permissions: AgentPermissionRequest[] = [];
  const listeners = new Set<(e: { resource: string }) => void>();
  const prompts: PendingPrompt[] = [];
  const opened: OpenAgentSessionInput[] = [];
  const replies: { id: string; reply: string }[] = [];
  /** `connection` counts drops: a handle is live while it matches. */
  const state = {
    cancelled: 0,
    closed: 0,
    nextSession: 1,
    connection: 0,
    status: opts.status ?? "running",
  };
  let onUpdate: ((n: SessionNotification) => void) | undefined;

  const emit = () => {
    for (const l of [...listeners]) l({ resource: "permissions" });
  };

  const handleFor = (sessionId: string, connection = state.connection) => ({
    sessionId,
    sandboxId: SANDBOX,
    get live() {
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
      get: async () => ({
        id: SANDBOX,
        status: state.status,
        annotations:
          "annotations" in opts
            ? opts.annotations
            : { "atelier.dev/harness": "opencode" },
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
      permissionsFor: () => [...permissions],
      replyPermission: (_sandbox: string, id: string, reply: string) => {
        const at = permissions.findIndex((p) => p.id === id);
        if (at === -1) return { ok: false, status: 404 };
        permissions.splice(at, 1);
        replies.push({ id, reply });
        emit();
        return { ok: true };
      },
      subscribe: (_sandbox: string, l: (e: { resource: string }) => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      todosFor: async () => [],
    } as unknown as AgentTaskServiceDeps["dispatch"],
  };

  return {
    deps,
    opened,
    prompts,
    replies,
    state,
    listeners,
    permissions,
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
    /** The agent raises a permission request. */
    askPermission(id = "perm-1", sessionId = SESSION) {
      permissions.push({ id, sessionId, permission: "Run a command" });
      emit();
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
  };
}
