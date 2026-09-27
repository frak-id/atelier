import { describe, expect, test } from "bun:test";
import { DEFAULT_LLM_BASE_URL, parseConfig } from "./config.ts";

const token = {
  name: "bot",
  sha256: "a".repeat(64),
  actor: { kind: "agent" as const, id: "agent:bot" },
  scopes: ["read" as const],
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

  test("llm defaults, and env overrides base url and model", () => {
    const config = parseConfig({}, {});
    expect(config.llm).toEqual({
      baseUrl: DEFAULT_LLM_BASE_URL,
      api: "anthropic-messages",
      model: "claude-sonnet-5",
      thinking: "medium",
    });
    expect(config.secrets.llmApiKey).toBeUndefined();
    const overridden = parseConfig(
      {},
      {
        HUB_LLM_BASE_URL: "https://example.com",
        HUB_LLM_MODEL: "other-model",
        HUB_LLM_API_KEY: "secret-key",
      },
    );
    expect(overridden.llm.baseUrl).toBe("https://example.com");
    expect(overridden.llm.model).toBe("other-model");
    expect(overridden.secrets.llmApiKey).toBe("secret-key");
  });

  test("rejects a bad llm.api or thinking level", () => {
    expect(() => parseConfig({ llm: { api: "nope" } as never }, {})).toThrow(
      /llm.api/,
    );
    expect(() =>
      parseConfig({ llm: { thinking: "extreme" } as never }, {}),
    ).toThrow(/llm.thinking/);
  });

  test("retention defaults to 6 months, and env overrides it", () => {
    expect(parseConfig({}, {}).retention.slackMonths).toBe(6);
    expect(
      parseConfig({}, { HUB_SLACK_RETENTION_MONTHS: "3" }).retention
        .slackMonths,
    ).toBe(3);
    expect(() => parseConfig({ retention: { slackMonths: 0 } }, {})).toThrow(
      /slackMonths/,
    );
  });

  test("recaps defaults, and validation of its fields", () => {
    const config = parseConfig({}, {});
    expect(config.recaps).toEqual({
      enabled: true,
      piCommand: ["pi"],
      concurrency: 2,
      timeoutMinutes: 20,
      maxAreas: 30,
    });
    expect(() =>
      parseConfig({ recaps: { piCommand: [] } } as never, {}),
    ).toThrow(/piCommand/);
    expect(() =>
      parseConfig({ recaps: { concurrency: 0 } } as never, {}),
    ).toThrow(/concurrency/);
    expect(() =>
      parseConfig({ recaps: { maxAreas: -1 } } as never, {}),
    ).toThrow(/maxAreas/);
  });

  test("repos.recaps is left undefined (repo default true) unless set", () => {
    const config = parseConfig(
      { repos: [{ repo: "o/n", branch: "main", recaps: false }] },
      {},
    );
    expect(config.repos[0]?.recaps).toBe(false);
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
