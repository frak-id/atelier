/** Wraps the `codewiki` CLI: one-time non-interactive config, then
 * `generate` (full or `--update`, with a full-build retry if `--update`
 * fails). The API key is only ever passed as an argv value to a subprocess —
 * never logged — and redacted from any thrown error. */

import { rm } from "node:fs/promises";

import { redact } from "./config.ts";

export interface CommandRunner {
  /** Runs a command, streaming stdout/stderr to `onOutput` as it arrives.
   * Resolves with the exit code (never rejects on a non-zero exit — callers
   * decide what that means). */
  run(
    cmd: string[],
    opts: {
      cwd?: string;
      env?: Record<string, string>;
      onOutput?: (line: string) => void;
    },
  ): Promise<number>;
}

export const bunCommandRunner: CommandRunner = {
  async run(cmd, opts) {
    const proc = Bun.spawn(cmd, {
      cwd: opts.cwd,
      env: opts.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const pump = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (opts.onOutput && value) {
          for (const line of decoder.decode(value).split("\n")) {
            if (line.length > 0) opts.onOutput(line);
          }
        }
      }
    };
    await Promise.all([pump(proc.stdout), pump(proc.stderr), proc.exited]);
    return proc.exitCode ?? 1;
  },
};

export interface CodewikiOptions {
  homeDir: string;
  llmBaseUrl: string;
  llmApiKey: string;
  mainModel: string;
  fallbackModel: string;
  maxTokens: number;
  exclude: string | undefined;
  checkoutDir: string;
  wikiDir: string;
  /** Whether `wikiDir/metadata.json` already exists — decides full vs.
   * `--update`. */
  hasPreviousOutput: boolean;
}

export function buildConfigSetArgv(opts: CodewikiOptions): string[] {
  return [
    "codewiki",
    "config",
    "set",
    "--provider",
    "openai-compatible",
    "--api-key",
    opts.llmApiKey,
    "--base-url",
    opts.llmBaseUrl,
    "--main-model",
    opts.mainModel,
    "--cluster-model",
    opts.mainModel,
    "--fallback-model",
    opts.fallbackModel,
  ];
}

export function buildGenerateArgv(
  opts: CodewikiOptions,
  update: boolean,
): string[] {
  const argv = [
    "codewiki",
    "generate",
    "-o",
    opts.wikiDir,
    "--max-tokens",
    String(opts.maxTokens),
  ];
  if (opts.exclude) {
    argv.push("--exclude", opts.exclude);
  }
  if (update) {
    argv.push("--update");
  }
  return argv;
}

function codewikiEnv(opts: CodewikiOptions): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    HOME: opts.homeDir,
    // Avoid a system-keyring (Secret Service / dbus) dependency inside a
    // minimal container image — store the key in ~/.codewiki instead.
    CODEWIKI_NO_KEYRING: "1",
  };
}

export interface GenerateResult {
  ok: boolean;
  usedUpdate: boolean;
  retriedAsFullBuild: boolean;
}

/** Configures CodeWiki (idempotent — `config set` just overwrites) then runs
 * `generate`. If `--update` is attempted (because `wikiDir` already has a
 * previous build) and it fails, retries once as a full build. */
export async function runCodewiki(
  opts: CodewikiOptions,
  log: (line: string) => void,
  runner: CommandRunner = bunCommandRunner,
): Promise<GenerateResult> {
  const env = codewikiEnv(opts);

  const configArgv = buildConfigSetArgv(opts);
  const configExit = await runner.run(configArgv, {
    cwd: opts.checkoutDir,
    env,
    onOutput: log,
  });
  if (configExit !== 0) {
    throw new Error(
      redact(`codewiki config set exited ${configExit}`, [opts.llmApiKey]),
    );
  }

  const useUpdate = opts.hasPreviousOutput;
  if (!useUpdate) {
    // A full build asks an interactive "overwrite?" confirmation if
    // `wikiDir` already has *.md files from a previous partial/crashed run
    // (this job's stdin is never a TTY) — clear it first so the CLI never
    // has anything to confirm.
    await rm(opts.wikiDir, { recursive: true, force: true });
  }
  const firstArgv = buildGenerateArgv(opts, useUpdate);
  const firstExit = await runner.run(firstArgv, {
    cwd: opts.checkoutDir,
    env,
    onOutput: log,
  });
  if (firstExit === 0) {
    return { ok: true, usedUpdate: useUpdate, retriedAsFullBuild: false };
  }

  if (!useUpdate) {
    return { ok: false, usedUpdate: false, retriedAsFullBuild: false };
  }

  log(`codewiki --update exited ${firstExit}; retrying as a full build`);
  const retryArgv = buildGenerateArgv(opts, false);
  const retryExit = await runner.run(retryArgv, {
    cwd: opts.checkoutDir,
    env,
    onOutput: log,
  });
  return {
    ok: retryExit === 0,
    usedUpdate: true,
    retriedAsFullBuild: true,
  };
}
