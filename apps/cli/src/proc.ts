/** Thin wrappers over `node:child_process` so the CLI stays engine-generic
 * (no `Bun.spawn`). Three shapes cover every call site: fire-and-forget,
 * inherit-the-terminal, and capture-stderr. */
import { spawn } from "node:child_process";

/** Launch a detached, best-effort process and forget about it (browser
 * openers). Never throws for a missing binary — the caller falls back to
 * printing the URL. */
export function spawnDetached(cmd: string[]): void {
  const [file, ...args] = cmd;
  if (!file) return;
  try {
    const child = spawn(file, args, {
      stdio: "ignore",
      detached: true,
    });
    child.on("error", () => {
      // No opener available (headless/SSH) — caller prints the URL as fallback.
    });
    child.unref();
  } catch {
    // Ignore — best-effort only.
  }
}

/** Run a process wired to the terminal (stdin/stdout/stderr inherited) and
 * resolve with its exit code. Used for interactive `ssh` sessions. */
export function runInherit(cmd: string[]): Promise<number> {
  const [file, ...args] = cmd;
  return new Promise((resolve, reject) => {
    if (!file) {
      reject(new Error("empty command"));
      return;
    }
    const child = spawn(file, args, { stdio: "inherit" });
    child.on("error", reject);
    // A null code means the child was killed by a signal — surface it as a
    // conventional non-zero code (128) rather than a fake success.
    child.on("close", (code, signal) =>
      resolve(signal ? 128 : (code ?? 0)),
    );
  });
}

/** Run a process and capture stderr, resolving with the exit code and the
 * collected stderr text. Used for `ssh-keygen`. */
export function runCapture(
  cmd: string[],
): Promise<{ code: number; stderr: string }> {
  const [file, ...args] = cmd;
  return new Promise((resolve, reject) => {
    if (!file) {
      reject(new Error("empty command"));
      return;
    }
    const child = spawn(file, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code, signal) =>
      resolve({ code: signal ? 128 : (code ?? 0), stderr }),
    );
  });
}
