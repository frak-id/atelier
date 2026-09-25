import { describe, expect, test } from "bun:test";
import { parseConfig } from "./config.ts";

const token = {
  name: "bot",
  sha256: "a".repeat(64),
  actor: { kind: "agent" as const, id: "agent:bot" },
  scopes: ["read" as const],
  audience: ["org"],
};

describe("parseConfig", () => {
  test("defaults, and secrets only from the environment", () => {
    const config = parseConfig({}, { HUB_WEBHOOK_SECRET: "s" });
    expect(config.port).toBe(4100);
    expect(config.reindexIntervalMinutes).toBe(360);
    expect(config.secrets).toEqual({
      webhookSecret: "s",
      gitToken: undefined,
      embeddingsApiKey: undefined,
    });
  });

  test("the environment overrides the port", () => {
    expect(parseConfig({ port: 1 }, { HUB_PORT: "5000" }).port).toBe(5000);
  });

  test("rejects malformed tokens and repos", () => {
    expect(() =>
      parseConfig({ tokens: [{ ...token, sha256: "nope" }] }, {}),
    ).toThrow(/sha256/);
    expect(() =>
      parseConfig({ tokens: [{ ...token, scopes: ["root" as never] }] }, {}),
    ).toThrow(/unknown scope/);
    expect(() => parseConfig({ tokens: [token, token] }, {})).toThrow(
      /duplicate/,
    );
    expect(() =>
      parseConfig({ repos: [{ repo: "no-owner", branch: "main" }] }, {}),
    ).toThrow(/owner\/name/);
  });
});
