import type { Terminal } from "@xterm/xterm";

/**
 * Modified Enter for the console's xterm.js. xterm.js 6 sends a bare CR for
 * Enter whatever the modifiers, so a TUI can't tell Shift+Enter or
 * Ctrl+Enter from Enter and multi-line input submits instead.
 *
 * Native terminals report modifiers in an encoding the app opts into: xterm's
 * modifyOtherKeys (`CSI > 4 ; n m`, which pi and opencode enable when their
 * kitty protocol query goes unanswered) or the kitty keyboard protocol
 * (`CSI > flags u`). xterm.js ignores both requests, so {@link KeyboardModes}
 * follows them on the output stream and {@link encodeModifiedEnter} answers
 * in the encoding the app asked for.
 */

const LF = "\n";

type Params = readonly (number | number[])[];
type Screen = "normal" | "alternate";

/** The numeric value of `params[index]`; xterm.js reports an omitted
 * parameter as 0. */
function param(params: Params, index: number): number | undefined {
  const value = params[index];
  return Array.isArray(value) ? value[0] : value;
}

/** Kitty's flag stack is bounded; drop the oldest entries past this. */
const KITTY_STACK_LIMIT = 32;

/** The keyboard encodings the foreground app asked for. */
class KeyboardModes {
  /** modifyOtherKeys level, 0 when off. */
  modifyOtherKeys = 0;
  /** Kitty flag stacks: the main and alternate screens keep their own. */
  private readonly kitty: Record<Screen, number[]> = {
    normal: [],
    alternate: [],
  };

  constructor(private readonly screen: () => Screen = () => "normal") {}

  /** Kitty flags in effect on the active screen, 0 when none were pushed. */
  get kittyFlags(): number {
    return this.kitty[this.screen()].at(-1) ?? 0;
  }

  /** XTMODKEYS `CSI > Pp ; Pv m`. Only resource 4 (modifyOtherKeys) matters;
   * an omitted value resets it. */
  setModifyKeys(params: Params): void {
    if (param(params, 0) === 4) this.modifyOtherKeys = param(params, 1) ?? 0;
  }

  /** `CSI > Pp n` disables a key modifier resource. */
  disableModifyKeys(params: Params): void {
    if (param(params, 0) === 4) this.modifyOtherKeys = 0;
  }

  /** `CSI > flags u` pushes kitty flags. */
  pushKitty(params: Params): void {
    const stack = this.kitty[this.screen()];
    stack.push(param(params, 0) ?? 0);
    if (stack.length > KITTY_STACK_LIMIT) stack.shift();
  }

  /** `CSI < n u` pops n entries (default 1); popping past the bottom
   * empties the stack. */
  popKitty(params: Params): void {
    const stack = this.kitty[this.screen()];
    const count = param(params, 0) || 1;
    stack.splice(Math.max(0, stack.length - count));
  }

  /** `CSI = flags ; mode u` changes the flags in effect: mode 1 (default)
   * replaces them, 2 sets the given bits, 3 clears them. */
  setKitty(params: Params): void {
    const stack = this.kitty[this.screen()];
    const flags = param(params, 0) ?? 0;
    const current = stack.at(-1) ?? 0;
    const mode = param(params, 1) || 1;
    const next =
      mode === 2 ? current | flags : mode === 3 ? current & ~flags : flags;
    if (stack.length === 0) stack.push(next);
    else stack[stack.length - 1] = next;
  }

  /** A full reset (RIS) drops every mode. */
  reset(): void {
    this.modifyOtherKeys = 0;
    this.kitty.normal.length = 0;
    this.kitty.alternate.length = 0;
  }
}

/** Follows the keyboard mode requests a terminal's apps write. */
export function trackKeyboardModes(terminal: Terminal): {
  modes: KeyboardModes;
  dispose: () => void;
} {
  const modes = new KeyboardModes(() => terminal.buffer.active.type);
  const { parser } = terminal;
  const handlers = [
    parser.registerCsiHandler({ prefix: ">", final: "m" }, (params) => {
      modes.setModifyKeys(params);
      return true;
    }),
    parser.registerCsiHandler({ prefix: ">", final: "n" }, (params) => {
      modes.disableModifyKeys(params);
      return true;
    }),
    parser.registerCsiHandler({ prefix: ">", final: "u" }, (params) => {
      modes.pushKitty(params);
      return true;
    }),
    parser.registerCsiHandler({ prefix: "<", final: "u" }, (params) => {
      modes.popKitty(params);
      return true;
    }),
    parser.registerCsiHandler({ prefix: "=", final: "u" }, (params) => {
      modes.setKitty(params);
      return true;
    }),
    // RIS: forget the modes, then let xterm.js run its own reset.
    parser.registerEscHandler({ final: "c" }, () => {
      modes.reset();
      return false;
    }),
  ];
  return {
    modes,
    dispose: () => {
      for (const handler of handlers) handler.dispose();
    },
  };
}

type KeyChord = Pick<
  KeyboardEvent,
  "key" | "shiftKey" | "ctrlKey" | "altKey" | "metaKey"
>;

/**
 * The bytes for Enter with Shift or Ctrl held, or undefined to leave the key
 * to xterm.js (plain Enter, Alt+Enter, anything with Cmd/Meta).
 *
 * Ctrl+Enter always sends LF (Ctrl+J). Every agent TUI here takes LF as
 * "insert a newline" (pi, opencode, Claude Code, Codex), while pi has no
 * binding for an encoded Ctrl+Enter. Other combinations use the encoding
 * the app enabled, modifyOtherKeys first: pi pushes kitty flags before it
 * knows whether the terminal supports them, then turns modifyOtherKeys on
 * when it learns it doesn't. With neither enabled they fall back to LF too.
 */
export function encodeModifiedEnter(
  chord: KeyChord,
  modes: Pick<KeyboardModes, "modifyOtherKeys" | "kittyFlags">,
): string | undefined {
  if (chord.key !== "Enter" || chord.metaKey) return undefined;
  if (!chord.shiftKey && !chord.ctrlKey) return undefined;
  if (chord.ctrlKey && !chord.shiftKey && !chord.altKey) return LF;
  const modifier =
    1 +
    (chord.shiftKey ? 1 : 0) +
    (chord.altKey ? 2 : 0) +
    (chord.ctrlKey ? 4 : 0);
  if (modes.modifyOtherKeys > 0) return `\x1b[27;${modifier};13~`;
  if (modes.kittyFlags > 0) return `\x1b[13;${modifier}u`;
  return chord.altKey ? `\x1b${LF}` : LF;
}
