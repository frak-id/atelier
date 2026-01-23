import {
  createOpencodeClient,
  type Event,
  type EventSessionIdle,
  type EventSessionStatus,
} from "@opencode-ai/sdk/v2";

export type OpenCodeEvent =
  | { type: "session.idle"; sessionId: string }
  | { type: "session.status"; sessionId: string; status: SessionStatusType }
  | { type: "session.created"; sessionId: string }
  | { type: "error"; error: string }
  | { type: "connected" }
  | { type: "disconnected" };

export type SessionStatusType =
  | { type: "idle" }
  | { type: "retry"; attempt: number; message: string; next: number }
  | { type: "busy" };

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

    for await (const rawEvent of result.stream) {
      if (signal?.aborted) {
        break;
      }

      const event = rawEvent as Event;
      const mappedEvent = mapEvent(event);
      if (mappedEvent) {
        onEvent(mappedEvent);
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

function mapEvent(event: Event): OpenCodeEvent | null {
  switch (event.type) {
    case "session.idle": {
      const idleEvent = event as EventSessionIdle;
      return {
        type: "session.idle",
        sessionId: idleEvent.properties.sessionID,
      };
    }

    case "session.status": {
      const statusEvent = event as EventSessionStatus;
      return {
        type: "session.status",
        sessionId: statusEvent.properties.sessionID,
        status: statusEvent.properties.status as SessionStatusType,
      };
    }

    case "session.created": {
      const props = (
        event as unknown as { properties: { info: { id: string } } }
      ).properties;
      return {
        type: "session.created",
        sessionId: props.info.id,
      };
    }

    default:
      return null;
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
