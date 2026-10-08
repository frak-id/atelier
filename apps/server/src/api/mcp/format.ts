/**
 * Shared MCP tool result formatting: curated `text()` results,
 * `isError: true` for failures instead of letting exceptions bubble to a raw
 * 500-shaped MCP error.
 *
 * Results are compact JSON (no pretty-printing): the reader is a model, and
 * indentation is pure token cost.
 */
import { SandboxError } from "../../shared/errors.ts";

export function text(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
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

/**
 * Bound `value` to its last `max` characters (the end of command output, a
 * log or an agent reply is what matters). When something was cut, a short
 * marker line says how much, so the model never mistakes it for the whole.
 */
export function keepTail(
  value: string,
  max: number,
): { text: string; truncated: boolean } {
  if (value.length <= max) return { text: value, truncated: false };
  const dropped = value.length - max;
  return {
    text: `[… ${dropped} earlier chars truncated]\n${value.slice(-max)}`,
    truncated: true,
  };
}
