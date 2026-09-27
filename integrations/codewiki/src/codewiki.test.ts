import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildConfigSetArgv,
  buildGenerateArgv,
  type CodewikiOptions,
  runCodewiki,
} from "./codewiki.ts";

let homeDir: string;

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(tmpdir(), "codewiki-test-home-"));
});

afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true });
});

function baseOptions(
  overrides: Partial<CodewikiOptions> = {},
): CodewikiOptions {
  return {
    homeDir,
    llmBaseUrl: "http://cliproxy:8317/v1",
    llmApiKey: "sk-secret",
    mainModel: "claude-sonnet-5",
    fallbackModel: "claude-haiku-4-5",
    maxTokens: 64000,
    exclude: undefined,
    checkoutDir: "/data/repos/frak-id/atelier",
    wikiDir: "/data/wiki/frak-id/atelier",
    hasPreviousOutput: false,
    hasExistingPages: false,
    ...overrides,
  };
}

describe("buildConfigSetArgv", () => {
  test("configures the openai-compatible provider with both models, no --api-key", () => {
    const argv = buildConfigSetArgv(baseOptions());
    expect(argv).toEqual([
      "codewiki",
      "config",
      "set",
      "--provider",
      "openai-compatible",
      "--base-url",
      "http://cliproxy:8317/v1",
      "--main-model",
      "claude-sonnet-5",
      "--cluster-model",
      "claude-sonnet-5",
      "--fallback-model",
      "claude-haiku-4-5",
    ]);
    expect(argv).not.toContain("--api-key");
    expect(argv).not.toContain("sk-secret");
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

describe("runCodewiki credentials", () => {
  test("writes ~/.codewiki/credentials.json (mode 0600) instead of passing --api-key", async () => {
    await runCodewiki(baseOptions(), () => {}, {
      run: async (cmd) => {
        expect(cmd).not.toContain("sk-secret");
        return 0;
      },
    });
    const credentialsPath = path.join(homeDir, ".codewiki", "credentials.json");
    const raw = await readFile(credentialsPath, "utf8");
    expect(JSON.parse(raw)).toEqual({ api_key: "sk-secret" });
    const mode = (await stat(credentialsPath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("runCodewiki resume behavior", () => {
  test("genuine first build (no state, no pages) wipes wikiDir first", async () => {
    const wikiDir = await mkdtemp(path.join(tmpdir(), "codewiki-wiki-"));
    await Bun.write(path.join(wikiDir, "stray-temp-file.json"), "{}");
    try {
      await runCodewiki(
        baseOptions({
          wikiDir,
          hasPreviousOutput: false,
          hasExistingPages: false,
        }),
        () => {},
        { run: async () => 0 },
      );
      await expect(
        readFile(path.join(wikiDir, "stray-temp-file.json"), "utf8"),
      ).rejects.toThrow();
    } finally {
      await rm(wikiDir, { recursive: true, force: true });
    }
  });

  test("interrupted full build (pages, no metadata) does not wipe and feeds stdin y", async () => {
    const wikiDir = await mkdtemp(path.join(tmpdir(), "codewiki-wiki-"));
    await Bun.write(path.join(wikiDir, "SomeModule.md"), "# Some Module");
    const calls: { cmd: string[]; stdin?: string }[] = [];
    try {
      const result = await runCodewiki(
        baseOptions({
          wikiDir,
          hasPreviousOutput: false,
          hasExistingPages: true,
        }),
        () => {},
        {
          run: async (cmd, opts) => {
            calls.push({ cmd, stdin: opts.stdin });
            return 0;
          },
        },
      );
      expect(result.usedUpdate).toBe(false);
      await expect(
        readFile(path.join(wikiDir, "SomeModule.md"), "utf8"),
      ).resolves.toBe("# Some Module");
      const generateCall = calls.find((c) => c.cmd[1] === "generate");
      expect(generateCall?.cmd).not.toContain("--update");
      expect(generateCall?.stdin).toBe("y\n");
      const configCall = calls.find((c) => c.cmd[1] === "config");
      expect(configCall?.stdin).toBeUndefined();
    } finally {
      await rm(wikiDir, { recursive: true, force: true });
    }
  });

  test("a complete previous build uses --update with no stdin", async () => {
    const calls: { cmd: string[]; stdin?: string }[] = [];
    await runCodewiki(
      baseOptions({ hasPreviousOutput: true, hasExistingPages: true }),
      () => {},
      {
        run: async (cmd, opts) => {
          calls.push({ cmd, stdin: opts.stdin });
          return 0;
        },
      },
    );
    const generateCall = calls.find((c) => c.cmd[1] === "generate");
    expect(generateCall?.cmd).toContain("--update");
    expect(generateCall?.stdin).toBeUndefined();
  });

  test("retry-as-full-build after a failed --update also feeds stdin y", async () => {
    let generateCallCount = 0;
    const calls: { cmd: string[]; stdin?: string }[] = [];
    const result = await runCodewiki(
      baseOptions({ hasPreviousOutput: true, hasExistingPages: true }),
      () => {},
      {
        run: async (cmd, opts) => {
          calls.push({ cmd, stdin: opts.stdin });
          if (cmd[1] === "generate") {
            generateCallCount++;
            return generateCallCount === 1 ? 1 : 0;
          }
          return 0;
        },
      },
    );
    expect(result.retriedAsFullBuild).toBe(true);
    const generateCalls = calls.filter((c) => c.cmd[1] === "generate");
    expect(generateCalls).toHaveLength(2);
    expect(generateCalls[0]?.cmd).toContain("--update");
    expect(generateCalls[1]?.cmd).not.toContain("--update");
    expect(generateCalls[1]?.stdin).toBe("y\n");
  });
});

describe("runCodewiki", () => {
  test("runs config set then a full build when there's no previous output", async () => {
    const calls: string[][] = [];
    const result = await runCodewiki(
      baseOptions({ hasPreviousOutput: false, hasExistingPages: false }),
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
      baseOptions({ hasPreviousOutput: true, hasExistingPages: true }),
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
      baseOptions({ hasPreviousOutput: true, hasExistingPages: true }),
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
      baseOptions({ hasPreviousOutput: false, hasExistingPages: false }),
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
