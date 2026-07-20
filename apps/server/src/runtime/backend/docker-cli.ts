/**
 * Thin `docker` CLI wrapper shared by the Docker sandbox + volume backends.
 * Shelling out to the CLI (vs. an SDK) keeps the dependency surface at "a
 * docker binary on PATH", which every target (native Linux, Docker Desktop,
 * OrbStack, Lima) already provides. Uses `Bun.spawn` (the server runtime) so
 * we stay off `node:child_process`'s typings.
 */
export interface DockerResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run `docker <args>`, resolving to its exit code + captured output (never
 * rejects, so callers branch on `code`). `env` overrides/extends the spawned
 * process environment (e.g. `DOCKER_HOST` for a remote daemon) — pass it so a
 * one-shot query hits the same daemon as a streamed build. */
export async function docker(
  args: string[],
  bin = "docker",
  env?: Record<string, string>,
): Promise<DockerResult> {
  try {
    const child = Bun.spawn([bin, ...args], {
      env: env ? { ...process.env, ...env } : undefined,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stdout, stderr };
  } catch (e) {
    return { code: -1, stdout: "", stderr: `${e}` };
  }
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
export async function dockerStream(
  args: string[],
  onLog: (chunk: string) => void,
  options: {
    bin?: string;
    env?: Record<string, string>;
    signal?: AbortSignal;
  } = {},
): Promise<number> {
  const { bin = "docker", env, signal } = options;
  try {
    const child = Bun.spawn([bin, ...args], {
      env: env ? { ...process.env, ...env } : undefined,
      stdout: "pipe",
      stderr: "pipe",
      signal,
    });
    const pump = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) onLog(decoder.decode(value));
      }
    };
    await Promise.all([pump(child.stdout), pump(child.stderr)]);
    return await child.exited;
  } catch (e) {
    onLog(`${e}\n`);
    return -1;
  }
}
