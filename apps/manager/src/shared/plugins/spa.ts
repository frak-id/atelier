import { Elysia } from "elysia";

interface SpaFallbackOptions {
  /** Absolute or relative path to the directory containing index.html */
  assets: string;
  /** URL path prefixes that should NOT receive the SPA fallback */
  exclude: string[];
}

/**
 * Elysia plugin that serves index.html for unmatched GET requests,
 * enabling client-side routing in single-page applications.
 *
 * @elysiajs/static has no built-in SPA support (open issue since 2023).
 * This plugin uses `onError` with `as: "global"` so it fires after all
 * route handlers, only catching genuine NOT_FOUND misses.
 *
 * Bun.file() returns a Blob that Elysia serves with the correct MIME
 * type, avoiding the JSON-serialization bug (elysiajs/elysia#1515)
 * that affects raw HTML string returns from onError.
 */
export function spaFallback({ assets, exclude }: SpaFallbackOptions) {
  const indexFile = Bun.file(`${assets}/index.html`);

  return new Elysia({ name: "spa-fallback" }).onError(
    { as: "global" },
    ({ code, request, set }) => {
      if (code !== "NOT_FOUND") return;
      if (request.method !== "GET") return;

      const pathname = new URL(request.url).pathname;
      if (exclude.some((prefix) => pathname.startsWith(prefix))) {
        return;
      }

      set.headers["content-type"] = "text/html; charset=utf-8";
      set.headers["cache-control"] = "no-cache";
      return indexFile;
    },
  );
}
