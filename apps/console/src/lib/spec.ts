import type {
  PrebuildSpec,
  SandboxSpec,
  ToolboxConfigInput,
} from "@atelier/spec";
import {
  PrebuildSpecSchema,
  SandboxSpecSchema,
  ToolboxConfigInputSchema,
} from "@atelier/spec";
import type { TSchema } from "@sinclair/typebox";
import { Errors } from "@sinclair/typebox/errors";
import { Check } from "@sinclair/typebox/value";
import {
  type ParseError,
  parse as parseJsonc,
  printParseErrorCode,
} from "jsonc-parser";

const MAX_ERRORS = 10;

/** Typebox `Check` + short, path-prefixed error list. The one validation
 * primitive behind every spec editor (sandbox/prebuild/toolbox). */
export function validateAgainst<T>(
  schema: TSchema,
  value: unknown,
): { ok: true; value: T } | { ok: false; errors: string[] } {
  if (Check(schema, value)) return { ok: true, value: value as T };
  const errors = [...Errors(schema, value)]
    .slice(0, MAX_ERRORS)
    .map((error) => `${error.path || "/"} ${error.message}`);
  return { ok: false, errors };
}

export function validateSandboxSpec(
  value: unknown,
): { ok: true; spec: SandboxSpec } | { ok: false; errors: string[] } {
  const result = validateAgainst<SandboxSpec>(SandboxSpecSchema, value);
  return result.ok ? { ok: true, spec: result.value } : result;
}

/** Parse JSONC text then validate against `PrebuildSpecSchema` — the JSON-mode
 * seam for the prebuild editor's visual↔JSON toggle. */
export function parsePrebuildSpec(
  text: string,
): { ok: true; value: PrebuildSpec } | { ok: false; errors: string[] } {
  const parsed = parseSpecJsonc(text);
  if (!parsed.ok) return parsed;
  return validateAgainst<PrebuildSpec>(PrebuildSpecSchema, parsed.value);
}

/** Parse JSONC text then validate against `ToolboxConfigInputSchema` — the
 * JSON-mode seam for the toolbox editor's visual↔JSON toggle. */
export function parseToolboxInput(
  text: string,
): { ok: true; value: ToolboxConfigInput } | { ok: false; errors: string[] } {
  const parsed = parseSpecJsonc(text);
  if (!parsed.ok) return parsed;
  return validateAgainst<ToolboxConfigInput>(
    ToolboxConfigInputSchema,
    parsed.value,
  );
}

function describeParseError(error: ParseError): string {
  return `${printParseErrorCode(error.error)} at offset ${error.offset}`;
}

export function parseSpecJsonc(
  text: string,
): { ok: true; value: unknown } | { ok: false; errors: string[] } {
  const errors: ParseError[] = [];
  const value = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    return {
      ok: false,
      errors: errors.slice(0, MAX_ERRORS).map(describeParseError),
    };
  }
  return { ok: true, value };
}

interface ComposeSpecOptions {
  image: string;
  vcpus: number;
  memoryMb: number;
}

/** The bare spec skeleton (source + resources). Harness and tool surfaces
 * (vscode, browser, …) are NOT composed here — they come from the
 * toolboxes/toolsets applied to the spawn, never hardcoded UI toggles. */
export function composeSpec(opts: ComposeSpecOptions): SandboxSpec {
  return {
    source: { image: opts.image },
    resources: { vcpus: opts.vcpus, memoryMb: opts.memoryMb },
  } as SandboxSpec;
}
