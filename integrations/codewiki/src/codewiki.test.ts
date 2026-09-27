import { describe, expect, test } from "bun:test";

import {
  buildConfigSetArgv,
  buildGenerateArgv,
  type CodewikiOptions,
  runCodewiki,
} from "./codewiki.ts";

function baseOptions(
  overrides: Partial<CodewikiOptions> = {},
): CodewikiOptions {
  return {
    homeDir: "/data/codewiki-home",
    llmBaseUrl: "http://cliproxy:8317/v1",
    llmApiKey: "sk-secret",
    mainModel: "claude-sonnet-5",
    fallbackModel: "claude-haiku-4-5",
    maxTokens: 64000,
    exclude: undefined,
    checkoutDir: "/data/repos/frak-id/atelier",
    wikiDir: "/data/wiki/frak-id/atelier",
    hasPreviousOutput: false,
    ...overrides,
  };
}

describe("buildConfigSetArgv", () => {
  test("configures the openai-compatible provider with both models", () => {
    const argv = buildConfigSetArgv(baseOptions());
    expect(argv).toEqual([
      "codewiki",
      "config",
      "set",
      "--provider",
      "openai-compatible",
      "--api-key",
      "sk-secret",
      "--base-url",
      "http://cliproxy:8317/v1",
      "--main-model",
      "claude-sonnet-5",
      "--cluster-model",
      "claude-sonnet-5",
      "--fallback-model",
      "claude-haiku-4-5",
    ]);
  });
});

describe("buildGenerateArgv", () => {
  test("full build: -o and --max-tokens, no --update", () => {
    const argv = buildGenerateArgv(baseOptions(), false);
    expect(argv).toEqual([
      "codewiki",
      "generate",
      "-o",
      "/data/wiki/frak-id/atelier",
      "--max-tokens",
      "64000",
    ]);
  });

  test("incremental build adds --update", () => {
    const argv = buildGenerateArgv(baseOptions(), true);
    expect(argv).toContain("--update");
  });

  test("adds --exclude when configured", () => {
    const argv = buildGenerateArgv(
      baseOptions({ exclude: "*.test.ts,dist/*" }),
      false,
    );
    expect(argv).toContain("--exclude");
    expect(argv).toContain("*.test.ts,dist/*");
  });
});

describe("runCodewiki", () => {
  test("runs config set then a full build when there's no previous output", async () => {
    const calls: string[][] = [];
    const result = await runCodewiki(
      baseOptions({ hasPreviousOutput: false }),
      () => {},
      {
        run: async (cmd) => {
          calls.push(cmd);
          return 0;
        },
      },
    );
    expect(result).toEqual({
      ok: true,
      usedUpdate: false,
      retriedAsFullBuild: false,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.slice(0, 3)).toEqual(["codewiki", "config", "set"]);
    expect(calls[1]).not.toContain("--update");
  });

  test("runs --update when there's previous output", async () => {
    const calls: string[][] = [];
    const result = await runCodewiki(
      baseOptions({ hasPreviousOutput: true }),
      () => {},
      {
        run: async (cmd) => {
          calls.push(cmd);
          return 0;
        },
      },
    );
    expect(result.usedUpdate).toBe(true);
    expect(result.retriedAsFullBuild).toBe(false);
    expect(calls[1]).toContain("--update");
  });

  test("retries as a full build once when --update fails", async () => {
    const calls: string[][] = [];
    let generateCallCount = 0;
    const result = await runCodewiki(
      baseOptions({ hasPreviousOutput: true }),
      () => {},
      {
        run: async (cmd) => {
          calls.push(cmd);
          if (cmd[1] === "generate") {
            generateCallCount++;
            return generateCallCount === 1 ? 1 : 0;
          }
          return 0;
        },
      },
    );
    expect(result).toEqual({
      ok: true,
      usedUpdate: true,
      retriedAsFullBuild: true,
    });
    // config set, failed --update, retried full build
    expect(calls).toHaveLength(3);
    expect(calls[1]).toContain("--update");
    expect(calls[2]).not.toContain("--update");
  });

  test("a failed full build (no previous output) does not retry", async () => {
    const result = await runCodewiki(
      baseOptions({ hasPreviousOutput: false }),
      () => {},
      {
        run: async (cmd) => (cmd[1] === "generate" ? 1 : 0),
      },
    );
    expect(result).toEqual({
      ok: false,
      usedUpdate: false,
      retriedAsFullBuild: false,
    });
  });

  test("redacts the API key if config set fails", async () => {
    const promise = runCodewiki(baseOptions(), () => {}, {
      run: async (cmd) => (cmd.includes("config") ? 1 : 0),
    });
    await expect(promise).rejects.toThrow(/codewiki config set exited 1/);
    try {
      await promise;
    } catch (err) {
      expect(String(err)).not.toContain("sk-secret");
    }
  });
});
