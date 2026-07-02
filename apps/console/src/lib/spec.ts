import { composeOpencode, mergeSpecs, PRESETS } from "@atelier/compose";
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
  harness: boolean;
  presets: { vscode: boolean; terminal: boolean; browser: boolean };
  image: string;
  vcpus: number;
  memoryMb: number;
}

/** Base + selected harness/presets, folded left to right (last wins on
 * scalar conflicts, keyed-merge on arrays) via `@atelier/compose`. */
export function composeSpec(opts: ComposeSpecOptions): SandboxSpec {
  const fragments = [
    {
      source: { image: opts.image },
      resources: { vcpus: opts.vcpus, memoryMb: opts.memoryMb },
    },
    opts.harness ? composeOpencode() : {},
    opts.presets.vscode ? PRESETS.vscode() : {},
    opts.presets.terminal ? PRESETS.terminal() : {},
    opts.presets.browser ? PRESETS.browser() : {},
  ];
  return mergeSpecs(...fragments) as SandboxSpec;
}
