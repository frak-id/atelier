import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmConfig } from "../config.ts";
import { runPi } from "./pi.ts";

const llm: LlmConfig = {
  baseUrl: "http://cliproxy.local:8317",
  api: "anthropic-messages",
  model: "claude-sonnet-5",
  thinking: "medium",
};

/** A fake `pi`: echoes argv/env/models.json as JSON on stdout, node-only. */
const FAKE_PI = `
const fs = require("node:fs");
const path = require("node:path");
const modelsPath = path.join(process.env.PI_CODING_AGENT_DIR || "", "models.json");
const models = fs.existsSync(modelsPath)
  ? JSON.parse(fs.readFileSync(modelsPath, "utf8"))
  : null;
process.stdout.write(JSON.stringify({
  argv: process.argv.slice(2),
  env: process.env,
  models,
}));
`;

function fakePiScript(): string {
  const dir = mkdtempSync(join(tmpdir(), "hub-pi-fake-"));
  const file = join(dir, "fake-pi.js");
  writeFileSync(file, FAKE_PI);
  return file;
}

describe("runPi", () => {
  test("builds read-only argv, a scrubbed env and models.json", async () => {
    const script = fakePiScript();
    const out = await runPi({
      llm,
      apiKey: "hub-secret-key",
      cwd: process.cwd(),
      prompt: "hello world",
      tools: ["read", "grep", "find", "ls"],
      piCommand: ["node", script],
      timeoutMinutes: 1,
    });
    const parsed = JSON.parse(out);

    expect(parsed.argv).toContain("--offline");
    expect(parsed.argv).toContain("--provider");
    expect(parsed.argv).toContain("hub");
    expect(parsed.argv).toContain("--tools");
    expect(parsed.argv).toContain("read,grep,find,ls");
    expect(parsed.argv).not.toContain("bash");
    expect(parsed.argv).not.toContain("write");
    expect(parsed.argv).not.toContain("edit");
    const promptArg = parsed.argv.find((a: string) => a.startsWith("@"));
    expect(promptArg).toBeDefined();

    const env = parsed.env;
    expect(Object.keys(env).sort()).toEqual(
      [
        "HOME",
        "HUB_LLM_API_KEY",
        "PATH",
        "PI_CODING_AGENT_DIR",
        "PI_OFFLINE",
      ].sort(),
    );
    expect(env.HUB_LLM_API_KEY).toBe("hub-secret-key");
    expect(env.PI_OFFLINE).toBe("1");

    expect(parsed.models.providers.hub.baseUrl).toBe(llm.baseUrl);
    expect(parsed.models.providers.hub.api).toBe("anthropic-messages");
    expect(parsed.models.providers.hub.apiKey).toBe("$HUB_LLM_API_KEY");
    expect(parsed.models.providers.hub.models[0].id).toBe("claude-sonnet-5");
  });

  test("--no-tools when tools is empty (overview synthesis)", async () => {
    const script = fakePiScript();
    const out = await runPi({
      llm,
      apiKey: "k",
      cwd: process.cwd(),
      prompt: "synthesize",
      tools: [],
      piCommand: ["node", script],
      timeoutMinutes: 1,
    });
    const parsed = JSON.parse(out);
    expect(parsed.argv).toContain("--no-tools");
    expect(parsed.argv).not.toContain("--tools");
  });

  test("a non-zero exit throws with a redacted stderr tail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-pi-fail-"));
    const script = join(dir, "fail.js");
    writeFileSync(
      script,
      `process.stderr.write("failed with key hub-secret-key\\n"); process.exit(1);`,
    );
    await expect(
      runPi({
        llm,
        apiKey: "hub-secret-key",
        cwd: process.cwd(),
        prompt: "x",
        tools: ["read"],
        piCommand: ["node", script],
        timeoutMinutes: 1,
      }),
    ).rejects.toThrow(/exited 1/);
    try {
      await runPi({
        llm,
        apiKey: "hub-secret-key",
        cwd: process.cwd(),
        prompt: "x",
        tools: ["read"],
        piCommand: ["node", script],
        timeoutMinutes: 1,
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(String(err)).not.toContain("hub-secret-key");
      expect(String(err)).toContain("***");
    }
  });
});
