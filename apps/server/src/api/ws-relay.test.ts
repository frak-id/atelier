import { describe, expect, test } from "bun:test";
import { isUserInput } from "./ws-relay.ts";

const bytes = (s: string) => new TextEncoder().encode(s);
const ESC = "\u001b";

describe("isUserInput", () => {
  test("keystrokes, pastes and resizes are input", () => {
    for (const frame of [
      bytes("l"),
      bytes("\r"),
      bytes(`${ESC}[A`), // arrow up
      bytes(`${ESC}[200~pasted${ESC}[201~`),
      bytes(`${ESC}`), // a bare Escape
      { type: "resize", cols: 80, rows: 24 },
      "ls\n",
    ]) {
      expect(isUserInput(frame)).toBe(true);
    }
  });

  test("a terminal's own replies are not", () => {
    for (const frame of [
      bytes(`${ESC}[12;40R`), // cursor position report
      bytes(`${ESC}[?1;2c`), // primary device attributes
      bytes(`${ESC}[>0;276;0c`), // secondary device attributes
      bytes(`${ESC}[0n`), // status report
      bytes(`${ESC}[?2026;2$y`), // DECRQM reply
      bytes(`${ESC}]11;rgb:1e1e/1e1e/1e1e\u0007`), // OSC color reply (BEL)
      bytes(`${ESC}]10;rgb:ffff/ffff/ffff${ESC}\\`), // OSC color reply (ST)
      new Uint8Array(),
      null,
    ]) {
      expect(isUserInput(frame)).toBe(false);
    }
  });
});
