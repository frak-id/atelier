import { describe, expect, test } from "bun:test";

import {
  ConfigError,
  DEFAULT_BRANCH,
  DEFAULT_CODEWIKI_MAX_TOKENS,
  loadConfig,
  parseRepoRef,
  parseRepos,
  redact,
} from "./config.ts";

function baseEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    CODEWIKI_REPOS: "frak-id/atelier",
    LLM_API_KEY: "sk-test",
    ONYX_URL: "http://onyx-api-service.onyx.svc.cluster.local:8080",
    ONYX_API_KEY: "onyx-key",
    ONYX_CC_PAIR_ID: "3",
    ...overrides,
  };
}

describe("parseRepoRef", () => {
  test("parses owner/repo with the default branch", () => {
    expect(parseRepoRef("frak-id/atelier")).toEqual({
      owner: "frak-id",
      repo: "atelier",
      branch: DEFAULT_BRANCH,
    });
  });

  test("parses owner/repo@branch", () => {
    expect(parseRepoRef("frak-id/atelier@feat/onyx-knowledge")).toEqual({
      owner: "frak-id",
      repo: "atelier",
      branch: "feat/onyx-knowledge",
    });
  });

  test("rejects malformed entries", () => {
    expect(() => parseRepoRef("not-a-repo")).toThrow(ConfigError);
    expect(() => parseRepoRef("a/b/c")).toThrow(ConfigError);
    expect(() => parseRepoRef("")).toThrow(ConfigError);
  });
});

describe("parseRepos", () => {
  test("parses a comma-separated list, trimming whitespace", () => {
    expect(parseRepos("frak-id/atelier, frak-id/onyx@main")).toEqual([
      { owner: "frak-id", repo: "atelier", branch: "main" },
      { owner: "frak-id", repo: "onyx", branch: "main" },
    ]);
  });

  test("rejects an empty list", () => {
    expect(() => parseRepos("")).toThrow(ConfigError);
    expect(() => parseRepos("  ,  ")).toThrow(ConfigError);
  });
});

describe("loadConfig", () => {
  test("applies defaults", () => {
    const config = loadConfig(baseEnv());
    expect(config.repos).toEqual([
      { owner: "frak-id", repo: "atelier", branch: "main" },
    ]);
    expect(config.dataDir).toBe("/data");
    expect(config.codewikiMaxTokens).toBe(DEFAULT_CODEWIKI_MAX_TOKENS);
    expect(config.codewikiModel).toBe("claude-sonnet-5");
    expect(config.codewikiFallbackModel).toBe("claude-haiku-4-5");
    expect(config.dryRun).toBe(false);
  });

  test("honors overrides", () => {
    const config = loadConfig(
      baseEnv({
        DATA_DIR: "/srv/data",
        CODEWIKI_MAX_TOKENS: "40000",
        CODEWIKI_MODEL: "custom-model",
        CODEWIKI_EXCLUDE: "*.test.ts",
      }),
    );
    expect(config.dataDir).toBe("/srv/data");
    expect(config.codewikiMaxTokens).toBe(40000);
    expect(config.codewikiModel).toBe("custom-model");
    expect(config.codewikiExclude).toBe("*.test.ts");
  });

  test("requires LLM_API_KEY unless DRY_RUN", () => {
    expect(() => loadConfig(baseEnv({ LLM_API_KEY: undefined }))).toThrow(
      ConfigError,
    );
    expect(() =>
      loadConfig(baseEnv({ LLM_API_KEY: undefined, DRY_RUN: "1" })),
    ).not.toThrow();
  });

  test("requires ONYX_URL/ONYX_API_KEY/ONYX_CC_PAIR_ID unless DRY_RUN", () => {
    expect(() => loadConfig(baseEnv({ ONYX_URL: undefined }))).toThrow(
      ConfigError,
    );
    expect(() => loadConfig(baseEnv({ ONYX_API_KEY: undefined }))).toThrow(
      ConfigError,
    );
    expect(() => loadConfig(baseEnv({ ONYX_CC_PAIR_ID: undefined }))).toThrow(
      ConfigError,
    );
    expect(() =>
      loadConfig(
        baseEnv({
          ONYX_URL: undefined,
          ONYX_API_KEY: undefined,
          ONYX_CC_PAIR_ID: undefined,
          DRY_RUN: "1",
        }),
      ),
    ).not.toThrow();
  });

  test("rejects a non-integer CODEWIKI_MAX_TOKENS", () => {
    expect(() =>
      loadConfig(baseEnv({ CODEWIKI_MAX_TOKENS: "not-a-number" })),
    ).toThrow(ConfigError);
  });

  test("rejects a non-integer ONYX_CC_PAIR_ID", () => {
    expect(() =>
      loadConfig(baseEnv({ ONYX_CC_PAIR_ID: "not-a-number" })),
    ).toThrow(ConfigError);
  });
});

describe("redact", () => {
  test("removes every occurrence of the given secrets", () => {
    const message = "failed to fetch https://x:ghp_abc123@github.com/repo";
    expect(redact(message, ["ghp_abc123"])).toBe(
      "failed to fetch https://x:***@github.com/repo",
    );
  });

  test("ignores undefined secrets", () => {
    expect(redact("hello", [undefined])).toBe("hello");
  });
});
