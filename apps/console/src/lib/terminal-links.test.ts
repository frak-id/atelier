import { describe, expect, test } from "bun:test";
import { createTerminalLinkHandler } from "./terminal-links.ts";

const click = (mods: Partial<MouseEvent> = {}) =>
  ({ metaKey: false, ctrlKey: false, ...mods }) as MouseEvent;

function fakeElement() {
  const el = {
    title: "",
    removeAttribute(name: string) {
      if (name === "title") el.title = "";
    },
  };
  return el as unknown as HTMLElement & { title: string };
}

function setup(mac: boolean) {
  const opened: string[] = [];
  const element = fakeElement();
  const handler = createTerminalLinkHandler(
    element,
    (url) => opened.push(url),
    mac,
  );
  return { opened, element, handler };
}

const DOCS = "https://pi.dev/docs";

describe("createTerminalLinkHandler", () => {
  test("macOS: opens on Cmd+click only", () => {
    const { opened, handler } = setup(true);
    handler.activate(click(), DOCS);
    handler.activate(click({ ctrlKey: true }), DOCS);
    expect(opened).toEqual([]);
    handler.activate(click({ metaKey: true }), DOCS);
    expect(opened).toEqual([DOCS]);
  });

  test("elsewhere: opens on Ctrl+click only", () => {
    const { opened, handler } = setup(false);
    handler.activate(click(), DOCS);
    handler.activate(click({ metaKey: true }), DOCS);
    expect(opened).toEqual([]);
    handler.activate(click({ ctrlKey: true }), DOCS);
    expect(opened).toEqual([DOCS]);
  });

  test("never opens other schemes or malformed targets", () => {
    const { opened, handler } = setup(true);
    const cmd = click({ metaKey: true });
    handler.activate(cmd, "file:///home/dev/notes.md");
    handler.activate(cmd, "javascript:alert(1)");
    handler.activate(cmd, "not a url");
    expect(opened).toEqual([]);
  });

  test("shows the target and the gesture while hovering", () => {
    const { element, handler } = setup(false);
    handler.hover(click(), "https://example.com/x");
    expect(element.title).toBe("https://example.com/x\nCtrl-click to open");
    handler.leave();
    expect(element.title).toBe("");
  });
});
