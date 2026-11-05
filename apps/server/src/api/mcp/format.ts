/**
 * Shared MCP tool result formatting: curated `text()` results,
 * `isError: true` for failures instead of letting exceptions bubble to a raw
 * 500-shaped MCP error.
 *
 * Results are compact JSON (no pretty-printing): the reader is a model, and
 * indentation is pure token cost.
 */
import { SandboxError, ValidationError } from "../../shared/errors.ts";
import { isProduction } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import { redactAgentUrl } from "../../shared/lib/redact.ts";

const log = createChildLogger("mcp");

/**
 * A tool result: the JSON as text, and for an object also as
 * `structuredContent` (what `outputSchema` validates and typed clients read).
 * Both carry the same data. Lists are wrapped in an object by the tool, since
 * structured content must be one.
 */
export function text(value: unknown, isError = false) {
  const structured =
    !isError &&
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    ...(structured && {
      structuredContent: value as Record<string, unknown>,
    }),
    ...(isError && { isError: true }),
  };
}

/** Turn a thrown `SandboxError` (or any error) into a friendly tool result
 * instead of a 500-shaped MCP protocol error. Anything that is not a
 * `SandboxError` is a bug or an outage: it is logged with the tool's name,
 * and in production the caller only gets a generic message (the same masking
 * as `api/index.ts`); elsewhere the message, with any agent token masked. */
function errorResult(tool: string, error: unknown) {
  if (error instanceof SandboxError) {
    return text({ error: error.code, message: error.message }, true);
  }
  log.error({ tool, error }, "MCP tool failed");
  const message = redactAgentUrl(
    error instanceof Error ? error.message : String(error),
  );
  return text(
    {
      error: "INTERNAL_ERROR",
      message: isProduction() ? "Internal server error" : message,
    },
    true,
  );
}

/** Wrap a tool handler so any thrown error becomes a friendly `isError`
 * result instead of an MCP protocol-level error. */
export function safeTool<Args extends unknown[], R>(
  tool: string,
  handler: (...args: Args) => Promise<R>,
) {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (error) {
      return errorResult(tool, error);
    }
  };
}

/**
 * For tools that cover several modes (e.g. `get_sandbox` reads one sandbox
 * or lists them): reject params that were passed but do not apply in the
 * mode the call resolved to, naming them, instead of silently ignoring a
 * param the caller believes is in effect.
 */
export function rejectParams(
  params: Record<string, unknown>,
  why: string,
): void {
  const given = Object.keys(params)
    .filter((k) => params[k] !== undefined)
    .map((k) => `\`${k}\``);
  if (given.length > 0) throw new ValidationError(`${given.join(", ")} ${why}`);
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

/**
 * Bound `value` to `max` characters, keeping its start and its end (a
 * command's first error and its final lines both matter) with a marker for
 * the omitted middle.
 */
export function keepHeadTail(
  value: string,
  max: number,
): { text: string; truncated: boolean } {
  if (value.length <= max) return { text: value, truncated: false };
  const head = Math.floor(max / 4);
  const tail = max - head;
  const omitted = value.length - max;
  return {
    text: `${value.slice(0, head)}\n[… ${omitted} chars omitted …]\n${value.slice(-tail)}`,
    truncated: true,
  };
}
