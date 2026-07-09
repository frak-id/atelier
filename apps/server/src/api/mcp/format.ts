/**
 * Shared MCP tool result formatting (v1's `apps/manager/src/mcp` convention):
 * curated `text()` results, `isError: true` for failures instead of letting
 * exceptions bubble to a raw 500-shaped MCP error.
 */
import { SandboxError } from "../../shared/errors.ts";

export function text(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    ...(isError && { isError: true }),
  };
}

/** Turn a thrown `SandboxError` (or any error) into a friendly tool result
 * instead of a 500-shaped MCP protocol error. */
export function errorResult(error: unknown) {
  if (error instanceof SandboxError) {
    return text({ error: error.code, message: error.message }, true);
  }
  const message = error instanceof Error ? error.message : String(error);
  return text({ error: "INTERNAL_ERROR", message }, true);
}

/** Wrap a tool handler so any thrown error becomes a friendly `isError`
 * result instead of an MCP protocol-level error. */
export function safeTool<Args extends unknown[], R>(
  handler: (...args: Args) => Promise<R>,
) {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (error) {
      return errorResult(error);
    }
  };
}
