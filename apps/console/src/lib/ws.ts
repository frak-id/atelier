/**
 * Build an absolute ws(s):// URL for a server-owned path. Same-origin in dev
 * (vite proxy forwards `/v1` and `/sessions` with `ws: true`) and in the
 * deployed static build, so the httpOnly `sandbox_token` cookie rides the
 * upgrade request.
 */
export function wsUrl(path: string): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}${path}`;
}
