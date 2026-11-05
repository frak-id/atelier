import {
  type AnyMessage,
  type JsonRpcId,
  ndJsonStream,
  type Stream,
} from "@agentclientprotocol/sdk";
import { safeNanoid } from "../../shared/lib/id.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import { redactAgentUrl } from "../../shared/lib/redact.ts";

const log = createChildLogger("acp-stream");

const CANCEL_REQUEST_METHOD = "$/cancel_request";

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
    // No URL in the message: it carries the agent token and the pod IP, and
    // the error ends up in task records and tool results.
    log.debug({ url: redactAgentUrl(url) }, "ACP WebSocket error");
    readableController?.error(new Error("ACP WebSocket error"));
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
      () => {
        log.debug({ url: redactAgentUrl(url) }, "ACP WebSocket connect failed");
        reject(new Error("ACP WebSocket failed to connect"));
      },
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
      // Byte relay: chunk is always ArrayBuffer-backed at runtime; the cast
      // keeps this consumable under the DOM lib (browser clients import the
      // server's App type via Eden) where send() excludes SharedArrayBuffer.
      ws.send(chunk as Uint8Array<ArrayBuffer>);
    },
    close: closeSocket,
    abort: closeSocket,
  });

  return {
    stream: scopeToConnection(
      ndJsonStream(writable, readable),
      `${safeNanoid()}:`,
    ),
    close: closeSocket,
    ready,
  };
}

/**
 * Tag this connection's request ids so a stray response from another
 * connection is never taken for ours.
 *
 * The attach is dialled with `replay=0` (live output only), so there is no
 * replay to guess at. The SDK still numbers requests from 0 on every
 * connection, and the harness process outlives our sockets, so:
 *  - outgoing requests get ids tagged with a per-connection `tag` (restored
 *    on the way back), and an incoming response without our tag is dropped;
 *  - `$/cancel_request` names the wire id.
 * Agent requests and notifications pass through untouched.
 */
export function scopeToConnection(inner: Stream, tag: string): Stream {
  /** Wire id (tagged) -> the SDK's id, for the requests still in flight. */
  const sdkIds = new Map<string, JsonRpcId>();
  /** The SDK's id -> wire id, so `$/cancel_request` names the wire id. */
  const wireIds = new Map<JsonRpcId, string>();
  let seq = 0;

  const outgoing = new TransformStream<AnyMessage, AnyMessage>({
    transform(message, controller) {
      if ("method" in message && "id" in message) {
        const wireId = `${tag}${seq++}`;
        sdkIds.set(wireId, message.id);
        wireIds.set(message.id, wireId);
        controller.enqueue({ ...message, id: wireId });
        return;
      }
      if ("method" in message && message.method === CANCEL_REQUEST_METHOD) {
        const params = message.params as { requestId?: JsonRpcId } | undefined;
        const wireId =
          params?.requestId !== undefined
            ? wireIds.get(params.requestId)
            : undefined;
        if (wireId !== undefined) {
          controller.enqueue({
            ...message,
            params: { ...params, requestId: wireId },
          });
          return;
        }
      }
      controller.enqueue(message);
    },
  });
  // Errors surface through the SDK's own writes; the pipe only forwards.
  void outgoing.readable.pipeTo(inner.writable).catch(() => {});

  const incoming = new TransformStream<AnyMessage, AnyMessage>({
    transform(message, controller) {
      if ("method" in message) {
        controller.enqueue(message);
        return;
      }
      if (!("id" in message) || typeof message.id !== "string") return;
      if (!sdkIds.has(message.id)) return; // another connection's response
      const sdkId = sdkIds.get(message.id) as JsonRpcId;
      sdkIds.delete(message.id);
      wireIds.delete(sdkId);
      controller.enqueue({ ...message, id: sdkId });
    },
  });

  return {
    writable: outgoing.writable,
    readable: inner.readable.pipeThrough(incoming),
  };
}
