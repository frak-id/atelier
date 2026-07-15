/**
 * Thin `docker` CLI wrapper shared by the Docker sandbox + volume backends.
 * Shelling out to the CLI (vs. an SDK) keeps the dependency surface at "a
 * docker binary on PATH", which every target (native Linux, Docker Desktop,
 * OrbStack, Lima) already provides.
 */
import { spawn } from "node:child_process";

export interface DockerResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run `docker <args>`, resolving to its exit code + captured output (never
 * rejects, so callers branch on `code`). `env` overrides/extends the spawned
 * process environment (e.g. `DOCKER_HOST` for a remote daemon) — pass it so a
 * one-shot query hits the same daemon as a streamed build. */
export function docker(
  args: string[],
  bin = "docker",
  env?: Record<string, string>,
): Promise<DockerResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      env: env ? { ...process.env, ...env } : process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", (e) => resolve({ code: -1, stdout, stderr: `${e}` }));
    child.on("exit", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/**
 * Run `docker <args>`, streaming combined stdout+stderr chunks to `onLog` as
 * they arrive instead of buffering — for minutes-long operations (`build`,
 * `push`) where a caller needs live progress (e.g. an image build's `/logs`
 * stream) rather than a single result at the end. `env` overrides/extends the
 * spawned process's environment (e.g. `DOCKER_HOST` for a remote daemon).
 * `signal` kills the child promptly on abort. Resolves to the exit code only
 * (never rejects) — same "branch on code" contract as {@link docker}.
 */
export function dockerStream(
  args: string[],
  onLog: (chunk: string) => void,
  options: {
    bin?: string;
    env?: Record<string, string>;
    signal?: AbortSignal;
  } = {},
): Promise<number> {
  const { bin = "docker", env, signal } = options;
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      env: env ? { ...process.env, ...env } : process.env,
    });
    const onAbort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (d) => onLog(d.toString()));
    child.stderr.on("data", (d) => onLog(d.toString()));
    child.on("error", (e) => {
      signal?.removeEventListener("abort", onAbort);
      onLog(`${e}\n`);
      resolve(-1);
    });
    child.on("exit", (code) => {
      signal?.removeEventListener("abort", onAbort);
      resolve(code ?? -1);
    });
  });
}
