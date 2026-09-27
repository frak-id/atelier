/** Wraps the `codewiki` CLI: one-time non-interactive config, then
 * `generate` (full or `--update`, with a full-build retry if `--update`
 * fails). The LLM API key is never passed as an argv value (it would sit in
 * plaintext in `/proc/<pid>/cmdline` for as long as the subprocess runs) —
 * it's written straight to `<homeDir>/.codewiki/credentials.json` (mode
 * 0600, the exact fallback-storage schema CodeWiki's own ConfigManager reads
 * — `codewiki/cli/config_manager.py` `_save_api_key_to_file`/
 * `_load_api_key_from_file`, both keyed on `{"api_key": ...}`), and `config
 * set` runs without `--api-key` (config.py's `config_set` only requires at
 * least one option to be non-empty, and doesn't require `--api-key` — the
 * generate command's later `ConfigManager.get_api_key()` falls back to the
 * credentials file). Every error is still redacted before it can bubble
 * up. */

import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

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
      /** Piped to the child's stdin then closed. Used to answer CodeWiki's
       * interactive "already contains documentation. Overwrite?"
       * `click.confirm` (generate.py) when resuming an interrupted full
       * build without `--update` — this job's stdin is otherwise never a
       * TTY, so without this the confirm's `input()` hits EOF and CodeWiki
       * aborts (`click.confirm` -> `Abort`). */
      stdin?: string;
      onOutput?: (line: string) => void;
    },
  ): Promise<number>;
}

export const bunCommandRunner: CommandRunner = {
  async run(cmd, opts) {
    const proc = Bun.spawn(cmd, {
      cwd: opts.cwd,
      env: opts.env,
      stdin: opts.stdin !== undefined ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (opts.stdin !== undefined && proc.stdin) {
      proc.stdin.write(opts.stdin);
      proc.stdin.end();
    }
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
  /** An ephemeral, per-run HOME (the caller `mkdtemp`s this under
   * `os.tmpdir()` and removes it in a `finally` — see `sync.ts` — so
   * `~/.codewiki/credentials.json` never lands on the PVC). */
  homeDir: string;
  llmBaseUrl: string;
  llmApiKey: string;
  mainModel: string;
  fallbackModel: string;
  maxTokens: number;
  exclude: string | undefined;
  checkoutDir: string;
  wikiDir: string;
  /** Whether `wikiDir/metadata.json` already exists — a complete previous
   * build, so `--update` is safe. */
  hasPreviousOutput: boolean;
  /** Whether `wikiDir` already has any top-level `*.md` page, whether or
   * not `metadata.json` is present. True but `hasPreviousOutput` false means
   * an interrupted full build (crashed before metadata.json was written) —
   * see {@link runCodewiki}. */
  hasExistingPages: boolean;
}

export function buildConfigSetArgv(opts: CodewikiOptions): string[] {
  return [
    "codewiki",
    "config",
    "set",
    "--provider",
    "openai-compatible",
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

/** Writes `<homeDir>/.codewiki/credentials.json` with the exact shape
 * `ConfigManager._load_api_key_from_file` reads (`{"api_key": "..."}`),
 * mode 0600 like `_save_api_key_to_file` sets — so `codewiki generate`
 * finds the key via `ConfigManager.get_api_key()`'s file fallback even
 * though `config set` below is never given `--api-key`. */
async function writeCredentialsFile(
  homeDir: string,
  apiKey: string,
): Promise<void> {
  const configDir = path.join(homeDir, ".codewiki");
  await mkdir(configDir, { recursive: true });
  const credentialsPath = path.join(configDir, "credentials.json");
  await writeFile(
    credentialsPath,
    JSON.stringify({ api_key: apiKey }, null, 2),
  );
  await chmod(credentialsPath, 0o600);
}

export interface GenerateResult {
  ok: boolean;
  usedUpdate: boolean;
  retriedAsFullBuild: boolean;
}

/** Configures CodeWiki (idempotent — `config set` just overwrites) then runs
 * `generate`. If `--update` is attempted (because `wikiDir` already has a
 * complete previous build) and it fails, retries once as a full build.
 *
 * Resume behavior for a full build that gets interrupted (the process is
 * killed mid-generation, so `metadata.json` — written only at the very end,
 * see `documentation_generator.py` — never lands, but some module `*.md`
 * pages already did): this must NOT wipe `wikiDir` and NOT pass `--update`
 * (there's no saved dependency graph yet for `--update` to compare against,
 * only `--compare-to`/`metadata.json`-less updates fall back to a full
 * build anyway per generate.py's `_detect_changed_files`). It runs a plain
 * `generate` and feeds `"y\n"` on stdin to answer the interactive "already
 * contains documentation. Overwrite?" `click.confirm` that fires whenever
 * `not update and output_dir.exists() and list(output_dir.glob("*.md"))`
 * (generate.py, `generate_command`). Confirming does not delete anything —
 * it just proceeds into `generator.generate()`, whose module processing
 * loop (`documentation_generator.py` `generate_module_documentation`, see
 * the comment above `processing_order = self.get_processing_order(...)`
 * around line 216: "every module whose .md already exists short-circuits in
 * run_module_agent/generate_parent_module_docs") skips every module that
 * already has a doc on disk — exactly the resume behavior wanted. Only a
 * genuine first build (no prior state file for this repo AND no existing
 * `*.md` pages) wipes `wikiDir` first, clearing out any stray `temp/` or
 * partial `module_tree.json` from an even earlier abandoned attempt. */
export async function runCodewiki(
  opts: CodewikiOptions,
  log: (line: string) => void,
  runner: CommandRunner = bunCommandRunner,
): Promise<GenerateResult> {
  await writeCredentialsFile(opts.homeDir, opts.llmApiKey);
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
  const isGenuineFirstBuild = !opts.hasPreviousOutput && !opts.hasExistingPages;
  if (isGenuineFirstBuild) {
    await rm(opts.wikiDir, { recursive: true, force: true });
  }
  // Resuming an interrupted full build: not --update, but wikiDir already
  // has *.md pages, so CodeWiki will ask to overwrite — answer "y" (see the
  // function doc above for why that's resume-safe, not destructive).
  const resumingInterruptedBuild = !useUpdate && !isGenuineFirstBuild;

  const firstArgv = buildGenerateArgv(opts, useUpdate);
  const firstExit = await runner.run(firstArgv, {
    cwd: opts.checkoutDir,
    env,
    onOutput: log,
    stdin: resumingInterruptedBuild ? "y\n" : undefined,
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
    // hasPreviousOutput was true, so wikiDir has *.md pages from the prior
    // (--update-eligible) build — same overwrite confirm as above.
    stdin: opts.hasExistingPages ? "y\n" : undefined,
  });
  return {
    ok: retryExit === 0,
    usedUpdate: true,
    retriedAsFullBuild: true,
  };
}
