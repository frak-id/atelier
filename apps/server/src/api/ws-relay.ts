/**
 * Shared mechanics for the two Elysia `.ws()` byte-relays to an in-pod
 * upstream `ws://` URL (`/v1/sandboxes/:id/attach/:name` in `v1.routes.ts`,
 * the terminal bridge in `sessions.routes.ts`). Both relays are a transparent
 * duplex: upstream frames forward to the downstream client verbatim, and
 * (subject to each route's own policy — read-only mode, auth) downstream
 * frames forward to upstream.
 *
 * This module factors only the identical wiring — opening the upstream
 * socket, forwarding its frames down, and the outgoing frame-type guard. Each
 * route keeps its own auth/ownership checks, close codes, and any
 * route-specific message handling (v1's `ro`-mode drop, the terminal route's
 * JSON re-serialization fallback).
 *
 * See `AGENTS.md` "Browser-consumable `App` type": both routes participate in
 * the exported `App` type, traversed under the DOM lib by `apps/console`.
 * DOM's `WebSocket.send()` excludes `SharedArrayBuffer`-backed views, so the
 * outgoing cast to `Uint8Array<ArrayBuffer>` is a lib-compat narrowing only —
 * the value is always `ArrayBuffer`-backed at runtime (Bun delivers binary
 * frames as `Buffer`).
 */

/** The minimal downstream `ws` shape both routes' handlers rely on — an
 * Elysia `ElysiaWS`-like object with a `data` bag we stash the upstream
 * socket on. Kept structural (not imported from Elysia) so this module has
 * no dependency on a specific handler's inferred `data` type. */
export interface RelayDownstream {
  data: Record<string, unknown>;
  send(data: string | ArrayBufferLike | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

const UPSTREAM_KEY = "upstream";

function getUpstream(ws: RelayDownstream): WebSocket | undefined {
  return ws.data[UPSTREAM_KEY] as WebSocket | undefined;
}

/**
 * Open the upstream WebSocket and wire its frames back down to `ws`,
 * stashing the socket on `ws.data.upstream` (read back by
 * {@link relayMessage} / {@link closeUpstream}). Binary frames forward as
 * `Buffer`, text frames forward as-is. Upstream close/error close the
 * downstream socket (matching both routes' prior behavior exactly: a plain
 * `close()` on `onclose`, `close(1011, "Upstream error")` on `onerror`).
 */
export function openUpstreamRelay(ws: RelayDownstream, url: string): WebSocket {
  const upstream = new WebSocket(url);
  upstream.binaryType = "arraybuffer";
  upstream.onmessage = (event) => {
    const data = event.data;
    if (data instanceof ArrayBuffer) ws.send(Buffer.from(data));
    else if (typeof data === "string") ws.send(data);
  };
  upstream.onclose = () => ws.close();
  upstream.onerror = () => ws.close(1011, "Upstream error");
  ws.data[UPSTREAM_KEY] = upstream;
  return upstream;
}

/**
 * Forward one downstream→upstream frame, iff an upstream socket is stashed
 * and open. String frames forward as-is; `Uint8Array` frames forward with the
 * DOM-lib-compat cast (see module doc). Returns `false` when there was no
 * open upstream to forward to (nothing sent) so a caller can layer its own
 * fallback (e.g. the terminal route's JSON re-serialization) on the same
 * "no known frame type matched" case.
 */
export function relayMessage(ws: RelayDownstream, message: unknown): boolean {
  const upstream = getUpstream(ws);
  if (!upstream || upstream.readyState !== WebSocket.OPEN) return false;
  if (typeof message === "string") {
    upstream.send(message);
    return true;
  }
  if (message instanceof Uint8Array) {
    upstream.send(message as Uint8Array<ArrayBuffer>);
    return true;
  }
  return false;
}

/** Close the stashed upstream socket if still open — the shared `close()`
 * handler body for both routes. */
export function closeUpstream(ws: RelayDownstream): void {
  const upstream = getUpstream(ws);
  if (upstream?.readyState === WebSocket.OPEN) upstream.close();
}
