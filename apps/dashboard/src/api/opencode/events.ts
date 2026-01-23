import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2";

export type { Event };

const TRACKED_EVENTS = new Set([
  "session.idle",
  "session.status",
  "session.created",
  "message.updated",
] as const);

type TrackedEventType = typeof TRACKED_EVENTS extends Set<infer T> ? T : never;

export type OpenCodeEvent =
  | (Event & { type: TrackedEventType })
  | { type: "error"; error: string }
  | { type: "connected" }
  | { type: "disconnected" };

interface SubscribeOptions {
  signal?: AbortSignal;
  onEvent: (event: OpenCodeEvent) => void;
  onError?: (error: Error) => void;
}

export async function subscribeToOpenCodeEvents(
  baseUrl: string,
  options: SubscribeOptions,
): Promise<void> {
  const { signal, onEvent, onError } = options;

  const client = createOpencodeClient({ baseUrl });

  try {
    const result = await client.event.subscribe(undefined, {
      signal,
      sseMaxRetryAttempts: 5,
      sseDefaultRetryDelay: 3000,
      sseMaxRetryDelay: 15000,
    });

    onEvent({ type: "connected" });

    for await (const event of result.stream) {
      if (signal?.aborted) break;

      if (TRACKED_EVENTS.has(event.type as TrackedEventType)) {
        onEvent(event as OpenCodeEvent);
      }
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      onEvent({ type: "disconnected" });
      return;
    }

    onEvent({ type: "error", error: String(error) });
    onError?.(error instanceof Error ? error : new Error(String(error)));
  } finally {
    onEvent({ type: "disconnected" });
  }
}

export class OpenCodeEventManager {
  private connections = new Map<string, AbortController>();

  subscribe(
    sandboxId: string,
    baseUrl: string,
    onEvent: (event: OpenCodeEvent) => void,
  ): void {
    if (this.connections.has(sandboxId)) {
      return;
    }

    const controller = new AbortController();
    this.connections.set(sandboxId, controller);

    subscribeToOpenCodeEvents(baseUrl, {
      signal: controller.signal,
      onEvent,
      onError: (error) => {
        console.error(`SSE error for sandbox ${sandboxId}:`, error);
        this.connections.delete(sandboxId);
      },
    });
  }

  unsubscribe(sandboxId: string): void {
    const controller = this.connections.get(sandboxId);
    if (controller) {
      controller.abort();
      this.connections.delete(sandboxId);
    }
  }

  unsubscribeAll(): void {
    for (const controller of this.connections.values()) {
      controller.abort();
    }
    this.connections.clear();
  }

  isSubscribed(sandboxId: string): boolean {
    return this.connections.has(sandboxId);
  }
}
