import { describe, expect, test } from "bun:test";
import { ValidationError } from "../../shared/errors.ts";
import { keepHeadTail, safeTool, text } from "./format.ts";

describe("text", () => {
  test("an object result is mirrored as structuredContent", () => {
    const result = text({ a: 1 });
    expect(result.content[0]?.text).toBe('{"a":1}');
    expect(result.structuredContent).toEqual({ a: 1 });
  });

  test("arrays and errors carry text only", () => {
    expect(text([1])).not.toHaveProperty("structuredContent");
    const error = text({ error: "X" }, true);
    expect(error.isError).toBe(true);
    expect(error).not.toHaveProperty("structuredContent");
  });
});

describe("safeTool", () => {
  test("a SandboxError becomes its code, any other error INTERNAL_ERROR", async () => {
    const invalid = await safeTool("t", async () => {
      throw new ValidationError("bad");
    })();
    expect(JSON.parse(invalid.content[0]?.text ?? "")).toEqual({
      error: "VALIDATION_ERROR",
      message: "bad",
    });
    const crashed = await safeTool("t", async () => {
      throw new Error("boom");
    })();
    expect(crashed.isError).toBe(true);
    expect(JSON.parse(crashed.content[0]?.text ?? "").error).toBe(
      "INTERNAL_ERROR",
    );
  });
});

describe("keepHeadTail", () => {
  test("short values pass, long ones keep their ends with a marker", () => {
    expect(keepHeadTail("abc", 10)).toEqual({ text: "abc", truncated: false });
    const cut = keepHeadTail(`START${"x".repeat(500)}END`, 40);
    expect(cut.truncated).toBe(true);
    expect(cut.text.startsWith("START")).toBe(true);
    expect(cut.text.endsWith("END")).toBe(true);
    expect(cut.text).toContain("chars omitted");
  });
});
