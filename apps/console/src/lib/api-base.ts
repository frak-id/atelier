/**
 * The single source of truth for where the v2 server lives. Same-origin in
 * dev (vite proxy) and in the deployed static build, so the httpOnly
 * `sandbox_token` cookie rides every request/upgrade.
 *
 * `VITE_API_BASE` overrides the origin for non-same-origin hosts — a future
 * Tauri desktop/mobile build, where the webview runs on a custom scheme and
 * the server lives at a separate HTTP address. Everything that talks to the
 * server (Eden fetch, WebSocket attach, SSE EventSource) resolves through
 * here so a single env var retargets the whole app.
 */
export const apiBase = (
  import.meta.env.VITE_API_BASE || window.location.origin
).replace(/\/+$/, "");

/** Absolute http(s) URL for a server-owned path. */
export function httpUrl(path: string): string {
  return `${apiBase}${path}`;
}

/** Absolute ws(s) URL for a server-owned path, derived from {@link apiBase}. */
export function wsUrl(path: string): string {
  const { protocol, host } = new URL(apiBase);
  const wsProto = protocol === "https:" ? "wss:" : "ws:";
  return `${wsProto}//${host}${path}`;
}

/** True when the server is a different origin (Tauri) — needs credentialed
 * EventSource, which is a no-op for same-origin. */
export const isCrossOrigin = apiBase !== window.location.origin;
