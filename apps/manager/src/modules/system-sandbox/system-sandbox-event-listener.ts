import {
  createOpencodeClient,
  type Event,
  type EventMessagePartUpdated,
  type EventSessionIdle,
  type ToolPart,
  type ToolStateCompleted,
} from "@opencode-ai/sdk/v2";
import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import { buildOpenCodeAuthHeaders } from "../../shared/lib/opencode-auth.ts";
import type { SandboxRepository } from "../sandbox/index.ts";

const log = createChildLogger("system-sandbox-listener");

const SSE_MAX_RETRY = 10;
const SSE_RETRY_DELAY = 3_000;
const SSE_MAX_RETRY_DELAY = 30_000;

interface TaskCallback {
  resolve: (taskId: string | undefined) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface IdleCallback {
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface SystemSandboxEventListenerDependencies {
  sandboxService: SandboxRepository;
}

export class SystemSandboxEventListener {
  private abortController: AbortController | null = null;
  private connected = false;
  private taskCallbacks = new Map<string, TaskCallback>();
  private idleCallbacks = new Map<string, IdleCallback>();

  constructor(private readonly deps: SystemSandboxEventListenerDependencies) {}

  start(sandboxId: string, opencodePassword?: string): void {
    this.stop();

    this.abortController = new AbortController();
    void this.connectLoop(sandboxId, opencodePassword, this.abortController);
  }

  stop(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.connected = false;

    const stopError = new Error("System sandbox event listener stopped");

    for (const callback of this.taskCallbacks.values()) {
      clearTimeout(callback.timeout);
      callback.reject(stopError);
    }
    this.taskCallbacks.clear();

    for (const callback of this.idleCallbacks.values()) {
      clearTimeout(callback.timeout);
      callback.reject(stopError);
    }
    this.idleCallbacks.clear();
  }

  isConnected(): boolean {
    return this.connected;
  }

  waitForTask(
    sessionId: string,
    timeoutMs = 90_000,
  ): Promise<string | undefined> {
    const existing = this.taskCallbacks.get(sessionId);
    if (existing) {
      clearTimeout(existing.timeout);
      existing.resolve(undefined);
      this.taskCallbacks.delete(sessionId);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.taskCallbacks.delete(sessionId);
        resolve(undefined);
      }, timeoutMs);

      this.taskCallbacks.set(sessionId, { resolve, reject, timeout });
    });
  }

  waitForIdle(sessionId: string, timeoutMs = 120_000): Promise<void> {
    const existing = this.idleCallbacks.get(sessionId);
    if (existing) {
      clearTimeout(existing.timeout);
      existing.resolve();
      this.idleCallbacks.delete(sessionId);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.idleCallbacks.delete(sessionId);
        resolve();
      }, timeoutMs);

      this.idleCallbacks.set(sessionId, { resolve, reject, timeout });
    });
  }

  healIfNeeded(sandboxId: string, opencodePassword?: string): void {
    if (!sandboxId || this.connected) {
      return;
    }

    log.warn(
      { sandboxId },
      "Listener disconnected while sandbox alive, healing",
    );
    this.start(sandboxId, opencodePassword);
  }

  private async connectLoop(
    sandboxId: string,
    opencodePassword: string | undefined,
    controller: AbortController,
  ): Promise<void> {
    let attempts = 0;

    while (!controller.signal.aborted) {
      try {
        const sandbox = this.deps.sandboxService.getById(sandboxId);
        const ipAddress = sandbox?.runtime?.ipAddress;

        if (!ipAddress) {
          throw new Error("System sandbox missing IP address");
        }

        const opcClient = createOpencodeClient({
          baseUrl: `http://${ipAddress}:${config.advanced.vm.opencode.port}`,
          headers: buildOpenCodeAuthHeaders(opencodePassword),
        });

        const result = await opcClient.event.subscribe(undefined, {
          signal: controller.signal,
          sseMaxRetryAttempts: SSE_MAX_RETRY,
          sseDefaultRetryDelay: SSE_RETRY_DELAY,
          sseMaxRetryDelay: SSE_MAX_RETRY_DELAY,
        });

        this.connected = true;
        attempts = 0;

        for await (const event of result.stream) {
          if (controller.signal.aborted) break;
          this.handleEvent(event as Event);
        }

        this.connected = false;

        if (!controller.signal.aborted) {
          log.warn(
            { sandboxId },
            "System sandbox SSE stream ended unexpectedly, reconnecting",
          );
        }
      } catch (error) {
        this.connected = false;

        if (error instanceof Error && error.name === "AbortError") {
          return;
        }

        attempts += 1;

        if (attempts > SSE_MAX_RETRY) {
          log.error(
            { sandboxId, error, attempts },
            "System sandbox SSE failed after max retries",
          );
          return;
        }

        const delay = Math.min(
          SSE_RETRY_DELAY * 2 ** (attempts - 1),
          SSE_MAX_RETRY_DELAY,
        );

        log.warn(
          { sandboxId, error, attempts, delay },
          "System sandbox SSE failed, reconnecting",
        );

        await Bun.sleep(delay);
      }
    }
  }

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

    const toolPart = part as ToolPart;
    if (!toolPart.tool.endsWith("create_task")) return;
    if (toolPart.state.status !== "completed") return;

    const completedState = toolPart.state as ToolStateCompleted;

    try {
      const output = JSON.parse(completedState.output);
      const taskId =
        output && typeof output === "object" && "id" in output
          ? output.id
          : undefined;

      if (typeof taskId === "string") {
        this.resolveTaskCallback(toolPart.sessionID, taskId);
      }
    } catch (error) {
      log.warn(
        { tool: toolPart.tool, error },
        "Failed to parse create_task output from SSE",
      );
    }
  }

  private handleSessionIdle(event: EventSessionIdle): void {
    const sessionId = event.properties.sessionID;

    this.resolveIdleCallback(sessionId);
    this.resolveTaskCallback(sessionId, undefined);
  }

  private resolveTaskCallback(
    sessionId: string,
    taskId: string | undefined,
  ): void {
    const callback = this.taskCallbacks.get(sessionId);
    if (!callback) return;

    clearTimeout(callback.timeout);
    this.taskCallbacks.delete(sessionId);
    callback.resolve(taskId);
  }

  private resolveIdleCallback(sessionId: string): void {
    const callback = this.idleCallbacks.get(sessionId);
    if (!callback) return;

    clearTimeout(callback.timeout);
    this.idleCallbacks.delete(sessionId);
    callback.resolve();
  }
}
