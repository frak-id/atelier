/**
 * Runs a headless `pi` (https://pi.dev, the coding agent CLI) against a
 * checkout on disk: one prompt in, the final assistant text out. `pi` is
 * Node-only (crashes under Bun) and needs its own throwaway config dir and
 * a scrubbed environment, so this never inherits `process.env`.
 *
 * The invocation is read-only by contract: callers pass `tools` from
 * `["read", "grep", "find", "ls"]` (or `[]` for a tools-less synthesis
 * run). Nothing here ever grants `bash`, `write` or `edit`.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmConfig } from "../config.ts";

export interface RunPiOptions {
  llm: LlmConfig;
  apiKey: string;
  /** The checkout pi explores (its cwd). */
  cwd: string;
  prompt: string;
  /** Read-only tool names, or `[]` for a tools-less run. */
  tools: string[];
  piCommand: string[];
  timeoutMinutes: number;
}

const STDERR_TAIL_CHARS = 4000;

function redact(text: string, ...secrets: (string | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.replaceAll(secret, "***");
  }
  return out;
}

/** Builds `<tmp>/agent/models.json`: the one model pi is allowed to use. */
function modelsJson(llm: LlmConfig): string {
  return JSON.stringify({
    providers: {
      hub: {
        baseUrl: llm.baseUrl,
        api: llm.api,
        apiKey: "$HUB_LLM_API_KEY",
        models: [
          {
            id: llm.model,
            contextWindow: 200_000,
            maxTokens: 32_000,
            reasoning: true,
          },
        ],
      },
    },
  });
}

/**
 * Spawns `pi` headless with a throwaway `$HOME`/config dir and an
 * environment holding only `PATH`, `HOME`, `PI_CODING_AGENT_DIR`,
 * `PI_OFFLINE` and the hub's LLM key — never `process.env`. Always cleans
 * up the temp dir, even on timeout or a thrown error.
 */
export async function runPi(opts: RunPiOptions): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), "hub-pi-"));
  try {
    const agentDir = join(tmp, "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "models.json"), modelsJson(opts.llm));
    const promptFile = join(tmp, "prompt.md");
    await writeFile(promptFile, opts.prompt);

    const [bin, ...prefixArgs] = opts.piCommand;
    if (!bin) throw new Error("recaps.piCommand is empty");
    const toolArgs =
      opts.tools.length > 0
        ? ["--tools", opts.tools.join(",")]
        : ["--no-tools"];
    const args = [
      ...prefixArgs,
      "-p",
      "--no-session",
      "-ne",
      "-ns",
      "-np",
      "-nc",
      "--offline",
      "--provider",
      "hub",
      "--model",
      opts.llm.model,
      "--thinking",
      opts.llm.thinking,
      ...toolArgs,
      `@${promptFile}`,
    ];

    const proc = Bun.spawn([bin, ...args], {
      cwd: opts.cwd,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: tmp,
        PI_CODING_AGENT_DIR: agentDir,
        PI_OFFLINE: "1",
        HUB_LLM_API_KEY: opts.apiKey,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, opts.timeoutMinutes * 60_000);

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);

    if (timedOut) {
      throw new Error(
        `pi timed out after ${opts.timeoutMinutes}m: ${redact(
          stderr.slice(-STDERR_TAIL_CHARS),
          opts.apiKey,
        )}`,
      );
    }
    if (exitCode !== 0) {
      throw new Error(
        `pi exited ${exitCode}: ${redact(
          stderr.slice(-STDERR_TAIL_CHARS),
          opts.apiKey,
        )}`,
      );
    }
    return stdout;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
