import { describe, expect, test } from "bun:test";
import { quiet } from "./markdown.ts";

describe("the agent's text", () => {
  test("notifies no one and leaves no code fence open; emails are untouched", () => {
    expect(quiet("ping @alice and @some-org/devs, mail a@b.co")).toBe(
      "ping @\u200balice and @\u200bsome-org/devs, mail a@b.co",
    );
    expect(quiet("see:\n```ts\nconst a = 1;")).toBe(
      "see:\n```ts\nconst a = 1;\n```",
    );
    expect(quiet("```\nclosed\n```")).toBe("```\nclosed\n```");
  });

  test("has no raw HTML, and reads the same in code", () => {
    expect(
      quiet("<!-- hides the rest <details> <img src=x> `Array<string>` a < b"),
    ).toBe(
      "<\u200b!-- hides the rest <\u200bdetails> <\u200bimg src=x> `Array<\u200bstring>` a < b",
    );
  });
});
