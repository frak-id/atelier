/** Interactive prompt helpers on top of @clack/prompts. Every wrapper handles
 * Ctrl-C / Esc uniformly: print "cancelled" and exit 0 (a user abort is not an
 * error). */

import type { MultiSelectOptions, SelectOptions } from "@clack/prompts";
import * as clack from "@clack/prompts";

/** clack's cancel sentinel (a `unique symbol`, not exported by name). Typing
 * the parameter with the exact symbol lets inference strip it from `T`. */
type CancelSymbol = Extract<Awaited<ReturnType<typeof clack.text>>, symbol>;

/** Bail out cleanly when the user cancels a clack prompt. */
export function orCancel<T>(value: T | CancelSymbol): T {
  if (clack.isCancel(value)) {
    clack.cancel("Cancelled.");
    process.exit(0);
  }
  return value;
}

/** clack 1.x validators receive `string | undefined` (empty input); ours take
 * a plain string, so normalise before delegating. */
const adaptValidate = (validate?: (v: string) => string | undefined) =>
  validate && ((v: string | undefined) => validate(v ?? ""));

export const intro = (msg: string): void => clack.intro(msg);
export const outro = (msg: string): void => clack.outro(msg);
export const note = (msg: string, title?: string): void =>
  clack.note(msg, title);
export const logMsg = clack.log;

export function spinner(): {
  start: (msg?: string) => void;
  stop: (msg?: string) => void;
  error: (msg?: string) => void;
  cancel: (msg?: string) => void;
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
  return orCancel(
    await clack.text({ ...opts, validate: adaptValidate(opts.validate) }),
  );
}

export async function password(opts: {
  message: string;
  validate?: (v: string) => string | undefined;
}): Promise<string> {
  return orCancel(
    await clack.password({ ...opts, validate: adaptValidate(opts.validate) }),
  );
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
