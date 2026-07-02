import type { App } from "@atelier/server";
import { treaty } from "@elysiajs/eden";

/**
 * Type-safe client for the v2 server (`@atelier/server`). All server-owned
 * paths are same-origin in dev (vite proxy) and in the deployed static build,
 * so the httpOnly `sandbox_token` cookie rides every request.
 *
 * `VITE_API_BASE` overrides the origin for non-same-origin hosts (a future
 * Tauri desktop/mobile build, where the webview runs on a custom scheme and
 * the server lives at a separate HTTP address). Empty = same-origin.
 */
const apiBase = import.meta.env.VITE_API_BASE || window.location.origin;

export const api = treaty<App>(apiBase, {
  fetch: { credentials: "include" },
});
