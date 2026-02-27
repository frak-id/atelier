import type { Event, OpencodeClient } from "@opencode-ai/sdk/v2";

export const OPENCODE_SSE_DEFAULTS = {
  maxRetryAttempts: 10,
  retryDelayMs: 3_000,
  maxRetryDelayMs: 30_000,
} as const;

type ReconnectReason = "stream_end" | "error";

export interface RunOpencodeEventStreamOptions {
  /** Abort signal to stop the subscription. */
  signal: AbortSignal;
  /**
   * Factory called on each (re)connect to obtain a client.
   * Called every attempt so callers that need to re-resolve
   * an IP address can do so transparently.
   */
  getClient: () => OpencodeClient | Promise<OpencodeClient>;
  /** Called for each SSE event. Handler errors are swallowed. */
  onEvent: (event: Event) => void | Promise<void>;
  /** Called when connection state changes. */
  setConnected?: (connected: boolean) => void;
  /** Called before each reconnect attempt with reason. */
  onReconnect?: (args: {
    reason: ReconnectReason;
    error?: unknown;
    delayMs: number;
  }) => void;
  /** Delay between reconnect attempts. */
  reconnectDelayMs?: number;
}

/**
 * Persistent SSE subscription loop for OpenCode event streams.
 *
 * Subscribes to `client.event.subscribe()`, iterates events, and
 * reconnects on stream end or error with a fixed delay.
 * Stops only when the abort signal fires.
 */
export async function runOpencodeEventStream(
  options: RunOpencodeEventStreamOptions,
): Promise<void> {
  const {
    signal,
    getClient,
    onEvent,
    setConnected,
    onReconnect,
    reconnectDelayMs = OPENCODE_SSE_DEFAULTS.retryDelayMs,
  } = options;

  let connected = false;

  const markDisconnected = () => {
    if (connected) {
      connected = false;
      setConnected?.(false);
    }
  };

  while (!signal.aborted) {
    try {
      const client = await getClient();
      const result = await client.event.subscribe(undefined, {
        signal,
        sseMaxRetryAttempts: OPENCODE_SSE_DEFAULTS.maxRetryAttempts,
        sseDefaultRetryDelay: OPENCODE_SSE_DEFAULTS.retryDelayMs,
        sseMaxRetryDelay: OPENCODE_SSE_DEFAULTS.maxRetryDelayMs,
      });

      if (!connected) {
        connected = true;
        setConnected?.(true);
      }

      for await (const event of result.stream) {
        if (signal.aborted) break;
        try {
          await onEvent(event as Event);
        } catch {
          /* handler errors must not kill the stream */
        }
      }

      markDisconnected();
      if (signal.aborted) return;

      onReconnect?.({
        reason: "stream_end",
        delayMs: reconnectDelayMs,
      });
    } catch (error) {
      markDisconnected();

      if (error instanceof Error && error.name === "AbortError") {
        return;
      }
      if (signal.aborted) return;

      onReconnect?.({
        reason: "error",
        error,
        delayMs: reconnectDelayMs,
      });
    }

    if (signal.aborted) return;
    await Bun.sleep(reconnectDelayMs);
  }
}
