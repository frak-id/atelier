import type { SandboxSpec } from "@atelier/spec";
import { SandboxSpecSchema } from "@atelier/spec";
import { Errors } from "@sinclair/typebox/errors";
import { Check } from "@sinclair/typebox/value";
import {
  type ParseError,
  parse as parseJsonc,
  printParseErrorCode,
} from "jsonc-parser";

const MAX_ERRORS = 10;

export function validateSandboxSpec(
  value: unknown,
): { ok: true; spec: SandboxSpec } | { ok: false; errors: string[] } {
  if (Check(SandboxSpecSchema, value)) return { ok: true, spec: value };
  const errors = [...Errors(SandboxSpecSchema, value)]
    .slice(0, MAX_ERRORS)
    .map((error) => `${error.path || "/"} ${error.message}`);
  return { ok: false, errors };
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
