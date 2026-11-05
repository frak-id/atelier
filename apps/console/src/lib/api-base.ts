/**
 * Where the server lives: always the page's own origin (vite proxy in dev,
 * nginx in the deployed static build), so the httpOnly `sandbox_token` cookie
 * rides every request/upgrade.
 */
export const apiBase = window.location.origin;

/** Absolute http(s) URL for a server-owned path. */
export function httpUrl(path: string): string {
  return `${apiBase}${path}`;
}

/** Absolute ws(s) URL for a server-owned path. */
export function wsUrl(path: string): string {
  const wsProto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${wsProto}//${window.location.host}${path}`;
}
