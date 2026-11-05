import { describe, expect, test } from "bun:test";
import { redactAgentUrl } from "./redact.ts";

describe("redactAgentUrl", () => {
  test("masks the token whatever its position", () => {
    expect(
      redactAgentUrl("ws://10.0.0.5:9997/attach/acp?mode=rw&token=abc123&x=1"),
    ).toBe("ws://10.0.0.5:9997/attach/acp?mode=rw&token=[redacted]&x=1");
    expect(redactAgentUrl("ws://h:1/terminal/s1?token=abc123")).toBe(
      "ws://h:1/terminal/s1?token=[redacted]",
    );
  });

  test("masks a URL embedded in an error message", () => {
    expect(
      redactAgentUrl("failed: ws://h:1/attach/a?token=secret (closed)"),
    ).toBe("failed: ws://h:1/attach/a?token=[redacted] (closed)");
  });

  test("leaves a URL without a token alone", () => {
    expect(redactAgentUrl("ws://h:1/attach/a?mode=ro")).toBe(
      "ws://h:1/attach/a?mode=ro",
    );
    expect(redactAgentUrl("https://x/y?notoken=1")).toBe(
      "https://x/y?notoken=1",
    );
  });
});
