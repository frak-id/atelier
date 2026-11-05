import type { App } from "@atelier/server";
import { treaty } from "@elysiajs/eden";
import { apiBase } from "@/lib/api-base";

/**
 * Type-safe client for the server (`@atelier/server`). The origin is
 * the page's own origin, so the httpOnly `sandbox_token` cookie rides
 * every request.
 */
export const api = treaty<App>(apiBase, {
  fetch: { credentials: "include" },
});
