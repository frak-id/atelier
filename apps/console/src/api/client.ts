import type { App } from "@atelier/server";
import { treaty } from "@elysiajs/eden";
import { apiBase } from "@/lib/api-base";

/**
 * Type-safe client for the v2 server (`@atelier/server`). The origin comes
 * from `@/lib/api-base` (same-origin by default, `VITE_API_BASE` override for
 * Tauri), so the httpOnly `sandbox_token` cookie rides every request.
 */
export const api = treaty<App>(apiBase, {
  fetch: { credentials: "include" },
});
