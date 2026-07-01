import { ndJsonStream, type Stream } from "@agentclientprotocol/sdk";

/**
 * A live ACP transport: the SDK {@link Stream} plus a handle to close the
 * underlying WebSocket.
 */
export interface AcpTransport {
  stream: Stream;
  close: () => void;
  /** Resolves once the socket is open, or rejects if it fails to connect. */
  ready: Promise<void>;
}

/**
 * Bridge a WebSocket (to the in-pod ACP relay) into an ACP {@link Stream}.
 *
 * The pod's Rust ACP bridge is a transparent byte relay: harness stdout arrives
 * as binary WS frames carrying newline-delimited JSON-RPC, and bytes we send are
 * written verbatim to harness stdin. So we expose the socket as a raw byte
 * duplex and let {@link ndJsonStream} do all JSON-RPC framing — the SDK owns the
 * protocol, we only move bytes. (The SDK's own `createWebSocketStream` can't be
 * used here: it speaks text frames and parses JSON itself, whereas this relay is
 * binary and frames via ndJsonStream.)
 *
 * The readable has no high-water mark, matching the SDK's own WebSocket
 * transport: incoming ACP messages are enqueued as they arrive and drained by
 * the connection reader. Turns are bounded, so unbounded queueing is acceptable.
 */
export function connectAcpWebSocket(url: string): AcpTransport {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";

  let readableController: ReadableStreamDefaultController<Uint8Array> | null =
    null;
  let settled = false;
  let isOpen = false;

  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      readableController = controller;
    },
  });

  ws.addEventListener("message", (event: MessageEvent) => {
    // Skip once the readable is closed/errored: enqueueing on a settled
    // controller throws synchronously inside this WS callback (uncaught).
    if (!readableController || settled) return;
    const data = event.data;
    if (data instanceof ArrayBuffer) {
      readableController.enqueue(new Uint8Array(data));
    } else if (typeof data === "string") {
      readableController.enqueue(new TextEncoder().encode(data));
    }
  });

  // Clean end-of-stream: the harness closed its side normally.
  const closeReadable = () => {
    if (settled) return;
    settled = true;
    readableController?.close();
  };
  // Error the readable so pending ACP requests reject instead of hanging on a
  // silent EOF when the transport fails.
  const errorReadable = () => {
    if (settled) return;
    settled = true;
    readableController?.error(new Error(`ACP WebSocket error: ${url}`));
  };

  ws.addEventListener("close", closeReadable);
  ws.addEventListener("error", errorReadable);

  const ready = new Promise<void>((resolve, reject) => {
    ws.addEventListener(
      "open",
      () => {
        isOpen = true;
        resolve();
      },
      { once: true },
    );
    ws.addEventListener(
      "error",
      () => reject(new Error(`ACP WebSocket failed to connect: ${url}`)),
      { once: true },
    );
  });

  const closeSocket = () => {
    closeReadable();
    ws.close();
  };

  const writable = new WritableStream<Uint8Array>({
    async write(chunk) {
      if (!isOpen) await ready;
      ws.send(chunk);
    },
    close: closeSocket,
    abort: closeSocket,
  });

  return {
    stream: ndJsonStream(writable, readable),
    close: closeSocket,
    ready,
  };
}
