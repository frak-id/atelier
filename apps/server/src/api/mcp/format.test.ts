import { describe, expect, test } from "bun:test";
import { ValidationError } from "../../shared/errors.ts";
import { config } from "../../shared/lib/config.ts";
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

describe("safeTool in production", () => {
  test("an unexpected error's message is masked; elsewhere it is token-free", async () => {
    const boom = safeTool("t", async () => {
      throw new Error("failed ws://10.0.0.5:9997/attach/acp?token=secret");
    });
    const previous = config.server.mode;
    try {
      config.server.mode = "production";
      const masked = JSON.parse((await boom()).content[0]?.text ?? "");
      expect(masked).toEqual({
        error: "INTERNAL_ERROR",
        message: "Internal server error",
      });
      config.server.mode = "local";
      const dev = JSON.parse((await boom()).content[0]?.text ?? "");
      expect(dev.message).toContain("failed ws://10.0.0.5:9997");
      expect(dev.message).not.toContain("secret");
    } finally {
      config.server.mode = previous;
    }
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
