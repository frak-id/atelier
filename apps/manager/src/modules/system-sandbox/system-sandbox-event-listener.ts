import {
  createOpencodeClient,
  type Event,
  type EventMessagePartUpdated,
  type EventSessionIdle,
} from "@opencode-ai/sdk/v2";
import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import { buildOpenCodeAuthHeaders } from "../../shared/lib/opencode-auth.ts";
import { runOpencodeEventStream } from "../../shared/lib/opencode-sse.ts";
import type { SandboxRepository } from "../sandbox/index.ts";

const log = createChildLogger("system-sandbox-listener");

/* ------------------------------------------------------------------ */
/*  Generic callback infrastructure                                   */
/* ------------------------------------------------------------------ */

interface EventCallback<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface SystemSandboxEventListenerDependencies {
  sandboxService: SandboxRepository;
}

export class SystemSandboxEventListener {
  private abortController: AbortController | null = null;
  private connected = false;
  private taskCallbacks = new Map<string, EventCallback<string | undefined>>();
  private idleCallbacks = new Map<string, EventCallback<undefined>>();

  constructor(private readonly deps: SystemSandboxEventListenerDependencies) {}

  start(sandboxId: string, opencodePassword?: string): void {
    this.stop();

    this.abortController = new AbortController();
    void runOpencodeEventStream({
      signal: this.abortController.signal,
      getClient: () => {
        const sandbox = this.deps.sandboxService.getById(sandboxId);
        const ipAddress = sandbox?.runtime?.ipAddress;
        if (!ipAddress) {
          throw new Error("System sandbox missing IP address");
        }
        return createOpencodeClient({
          baseUrl: `http://${ipAddress}:${config.advanced.vm.opencode.port}`,
          headers: buildOpenCodeAuthHeaders(opencodePassword),
        });
      },
      onEvent: (event) => this.handleEvent(event),
      setConnected: (value) => {
        this.connected = value;
      },
      onReconnect: ({ reason, error }) => {
        log.warn(
          { sandboxId, reason, error },
          "System sandbox SSE reconnecting",
        );
      },
    });
  }

  stop(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.connected = false;

    const err = new Error("System sandbox event listener stopped");
    this.rejectAll(this.taskCallbacks, err);
    this.rejectAll(this.idleCallbacks, err);
  }

  isConnected(): boolean {
    return this.connected;
  }

  waitForTask(
    sessionId: string,
    timeoutMs = 90_000,
  ): Promise<string | undefined> {
    return this.registerWait(
      this.taskCallbacks,
      sessionId,
      timeoutMs,
      undefined,
    );
  }

  waitForIdle(sessionId: string, timeoutMs = 120_000): Promise<void> {
    return this.registerWait(
      this.idleCallbacks,
      sessionId,
      timeoutMs,
      undefined,
    ) as Promise<void>;
  }

  healIfNeeded(sandboxId: string, opencodePassword?: string): void {
    if (!sandboxId || this.connected) return;

    log.warn(
      { sandboxId },
      "Listener disconnected while sandbox alive, healing",
    );
    this.start(sandboxId, opencodePassword);
  }

  /* ---------------------------------------------------------------- */
  /*  Generic callback helpers                                        */
  /* ---------------------------------------------------------------- */

  private registerWait<T>(
    callbacks: Map<string, EventCallback<T>>,
    sessionId: string,
    timeoutMs: number,
    timeoutValue: T,
  ): Promise<T> {
    const existing = callbacks.get(sessionId);
    if (existing) {
      clearTimeout(existing.timeout);
      existing.resolve(timeoutValue);
      callbacks.delete(sessionId);
    }

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        callbacks.delete(sessionId);
        resolve(timeoutValue);
      }, timeoutMs);
      callbacks.set(sessionId, {
        resolve,
        reject,
        timeout,
      });
    });
  }

  private resolveCallback<T>(
    callbacks: Map<string, EventCallback<T>>,
    sessionId: string,
    value: T,
  ): void {
    const callback = callbacks.get(sessionId);
    if (!callback) return;

    clearTimeout(callback.timeout);
    callbacks.delete(sessionId);
    callback.resolve(value);
  }

  private rejectAll<T>(
    callbacks: Map<string, EventCallback<T>>,
    error: Error,
  ): void {
    for (const cb of callbacks.values()) {
      clearTimeout(cb.timeout);
      cb.reject(error);
    }
    callbacks.clear();
  }

  /* ---------------------------------------------------------------- */
  /*  Event handling                                                   */
  /* ---------------------------------------------------------------- */

  private handleEvent(event: Event): void {
    if (event.type === "message.part.updated") {
      this.handleMessagePartUpdated(event as EventMessagePartUpdated);
      return;
    }

    if (event.type === "session.idle") {
      this.handleSessionIdle(event as EventSessionIdle);
    }
  }

  private handleMessagePartUpdated(event: EventMessagePartUpdated): void {
    const part = event.properties.part;
    if (part.type !== "tool") return;
    if (!part.tool.endsWith("create_task")) return;
    if (part.state.status !== "completed") return;

    try {
      const output = JSON.parse(part.state.output);
      const taskId =
        output && typeof output === "object" && "id" in output
          ? output.id
          : undefined;

      if (typeof taskId === "string") {
        this.resolveCallback(this.taskCallbacks, part.sessionID, taskId);
      }
    } catch (error) {
      log.warn(
        { tool: part.tool, error },
        "Failed to parse create_task output from SSE",
      );
    }
  }

  private handleSessionIdle(event: EventSessionIdle): void {
    const sessionId = event.properties.sessionID;

    this.resolveCallback(this.idleCallbacks, sessionId, undefined);
    this.resolveCallback(this.taskCallbacks, sessionId, undefined);
  }
}
