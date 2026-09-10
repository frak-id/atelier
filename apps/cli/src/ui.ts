/** Interactive prompt helpers on top of @clack/prompts. Every wrapper handles
 * Ctrl-C / Esc uniformly: print "cancelled" and exit 0 (a user abort is not an
 * error). */

import type { MultiSelectOptions, SelectOptions } from "@clack/prompts";
import * as clack from "@clack/prompts";

/** Bail out cleanly when the user cancels a clack prompt. */
export function orCancel<T>(value: T | symbol): T {
  if (clack.isCancel(value)) {
    clack.cancel("Cancelled.");
    process.exit(0);
  }
  return value as T;
}

/** @clack/prompts v1 widened `validate` to receive `string | undefined` (and to
 * allow returning an Error). Our call sites all assume a plain string, so
 * normalise the value here rather than touching every prompt. */
function adaptValidate<T extends { validate?: (v: string) => string | undefined }>(
  opts: T,
): Omit<T, "validate"> & {
  validate?: (v: string | undefined) => string | undefined;
} {
  const { validate, ...rest } = opts;
  if (!validate) return rest;
  return { ...rest, validate: (v: string | undefined) => validate(v ?? "") };
}

export const intro = (msg: string): void => clack.intro(msg);
export const outro = (msg: string): void => clack.outro(msg);
export const note = (msg: string, title?: string): void =>
  clack.note(msg, title);
export const logMsg = clack.log;

export function spinner(): {
  start: (msg?: string) => void;
  stop: (msg?: string, code?: number) => void;
  message: (msg?: string) => void;
} {
  return clack.spinner();
}

// clack's `Option<Value>` is a conditional type (`Value extends Primitive ? …`)
// that can't resolve against an unconstrained generic, so these wrappers need a
// single cast to clack's own options type — our `label`-required shape always
// satisfies the non-primitive branch.
export async function select<T>(opts: {
  message: string;
  options: { value: T; label: string; hint?: string }[];
  initialValue?: T;
}): Promise<T> {
  return orCancel(await clack.select(opts as SelectOptions<T>));
}

export async function multiselect<T>(opts: {
  message: string;
  options: { value: T; label: string; hint?: string }[];
  required?: boolean;
  initialValues?: T[];
}): Promise<T[]> {
  return orCancel(await clack.multiselect(opts as MultiSelectOptions<T>));
}

export async function text(opts: {
  message: string;
  placeholder?: string;
  initialValue?: string;
  defaultValue?: string;
  validate?: (v: string) => string | undefined;
}): Promise<string> {
  return orCancel(await clack.text(adaptValidate(opts)));
}

export async function password(opts: {
  message: string;
  validate?: (v: string) => string | undefined;
}): Promise<string> {
  return orCancel(await clack.password(adaptValidate(opts)));
}

export async function confirm(opts: {
  message: string;
  initialValue?: boolean;
}): Promise<boolean> {
  return orCancel(await clack.confirm(opts));
}

/** True when stdout is a TTY — interactive flows require it. */
export function isInteractive(): boolean {
  return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}
