/** Interactive prompt helpers on top of @clack/prompts. Every wrapper handles
 * Ctrl-C / Esc uniformly: print "cancelled" and exit 0 (a user abort is not an
 * error). */
import * as clack from "@clack/prompts";

/** Bail out cleanly when the user cancels a clack prompt. */
export function orCancel<T>(value: T | symbol): T {
  if (clack.isCancel(value)) {
    clack.cancel("Cancelled.");
    process.exit(0);
  }
  return value as T;
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

export async function select<T>(opts: {
  message: string;
  options: { value: T; label: string; hint?: string }[];
  initialValue?: T;
}): Promise<T> {
  const r = await clack.select(
    opts as unknown as Parameters<typeof clack.select>[0],
  );
  return orCancel(r as T | symbol);
}

export async function multiselect<T>(opts: {
  message: string;
  options: { value: T; label: string; hint?: string }[];
  required?: boolean;
}): Promise<T[]> {
  const r = await clack.multiselect(
    opts as unknown as Parameters<typeof clack.multiselect>[0],
  );
  return orCancel(r as T[] | symbol);
}

export async function text(opts: {
  message: string;
  placeholder?: string;
  initialValue?: string;
  defaultValue?: string;
  validate?: (v: string) => string | undefined;
}): Promise<string> {
  return orCancel(await clack.text(opts));
}

export async function password(opts: {
  message: string;
  validate?: (v: string) => string | undefined;
}): Promise<string> {
  return orCancel(await clack.password(opts));
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
