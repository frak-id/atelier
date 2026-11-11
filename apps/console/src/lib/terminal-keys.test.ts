import { describe, expect, test } from "bun:test";
import { Terminal } from "@xterm/xterm";
import { encodeModifiedEnter, trackKeyboardModes } from "./terminal-keys.ts";

function setup() {
  const terminal = new Terminal({ allowProposedApi: true });
  const { modes } = trackKeyboardModes(terminal);
  const write = (data: string) =>
    new Promise<void>((resolve) => terminal.write(data, resolve));
  return { modes, write };
}

const enter = (mods: Partial<KeyboardEvent> = {}) => ({
  key: "Enter",
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

const LEGACY = { modifyOtherKeys: 0, kittyFlags: 0 };
const MODIFY_OTHER_KEYS = { modifyOtherKeys: 2, kittyFlags: 0 };
const KITTY = { modifyOtherKeys: 0, kittyFlags: 1 };

describe("trackKeyboardModes", () => {
  test("follows modifyOtherKeys on and off", async () => {
    const { modes, write } = setup();
    await write("\x1b[>4;2m");
    expect(modes.modifyOtherKeys).toBe(2);
    await write("\x1b[>4;0m");
    expect(modes.modifyOtherKeys).toBe(0);
    await write("\x1b[>4;1m\x1b[>4m");
    expect(modes.modifyOtherKeys).toBe(0);
    await write("\x1b[>4;1m\x1b[>4n");
    expect(modes.modifyOtherKeys).toBe(0);
  });

  test("ignores other key modifier resources", async () => {
    const { modes, write } = setup();
    await write("\x1b[>4;2m\x1b[>1;2m");
    expect(modes.modifyOtherKeys).toBe(2);
  });

  test("keeps the kitty flag stack", async () => {
    const { modes, write } = setup();
    await write("\x1b[>1u\x1b[>7u");
    expect(modes.kittyFlags).toBe(7);
    await write("\x1b[<u");
    expect(modes.kittyFlags).toBe(1);
    await write("\x1b[=8;2u");
    expect(modes.kittyFlags).toBe(9);
    await write("\x1b[=1;3u");
    expect(modes.kittyFlags).toBe(8);
    await write("\x1b[=3u");
    expect(modes.kittyFlags).toBe(3);
    await write("\x1b[<5u");
    expect(modes.kittyFlags).toBe(0);
  });

  test("the alternate screen has its own kitty stack", async () => {
    const { modes, write } = setup();
    await write("\x1b[>1u\x1b[?1049h");
    expect(modes.kittyFlags).toBe(0);
    await write("\x1b[>3u");
    expect(modes.kittyFlags).toBe(3);
    await write("\x1b[?1049l");
    expect(modes.kittyFlags).toBe(1);
  });

  test("a full reset drops every mode", async () => {
    const { modes, write } = setup();
    await write("\x1b[>4;2m\x1b[>1u\x1bc");
    expect(modes.modifyOtherKeys).toBe(0);
    expect(modes.kittyFlags).toBe(0);
  });
});

describe("encodeModifiedEnter", () => {
  test("leaves plain, Alt and Meta Enter to xterm.js", () => {
    expect(encodeModifiedEnter(enter(), MODIFY_OTHER_KEYS)).toBeUndefined();
    expect(
      encodeModifiedEnter(enter({ altKey: true }), MODIFY_OTHER_KEYS),
    ).toBeUndefined();
    expect(
      encodeModifiedEnter(
        enter({ metaKey: true, shiftKey: true }),
        MODIFY_OTHER_KEYS,
      ),
    ).toBeUndefined();
    expect(
      encodeModifiedEnter({ ...enter({ shiftKey: true }), key: "a" }, KITTY),
    ).toBeUndefined();
  });

  test("Ctrl+Enter is a line feed in every mode", () => {
    for (const modes of [LEGACY, MODIFY_OTHER_KEYS, KITTY]) {
      expect(encodeModifiedEnter(enter({ ctrlKey: true }), modes)).toBe("\n");
    }
  });

  test("Shift+Enter uses the encoding the app enabled", () => {
    const shift = enter({ shiftKey: true });
    expect(encodeModifiedEnter(shift, MODIFY_OTHER_KEYS)).toBe("\x1b[27;2;13~");
    expect(encodeModifiedEnter(shift, KITTY)).toBe("\x1b[13;2u");
    expect(
      encodeModifiedEnter(shift, { modifyOtherKeys: 2, kittyFlags: 7 }),
    ).toBe("\x1b[27;2;13~");
    expect(encodeModifiedEnter(shift, LEGACY)).toBe("\n");
  });

  test("combinations carry every modifier", () => {
    const all = enter({ shiftKey: true, ctrlKey: true, altKey: true });
    expect(encodeModifiedEnter(all, MODIFY_OTHER_KEYS)).toBe("\x1b[27;8;13~");
    expect(encodeModifiedEnter(all, KITTY)).toBe("\x1b[13;8u");
    expect(
      encodeModifiedEnter(enter({ shiftKey: true, altKey: true }), LEGACY),
    ).toBe("\x1b\n");
  });
});
