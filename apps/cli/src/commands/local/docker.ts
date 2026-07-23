/** Low-level Docker CLI primitives for `atelier local`: run a command capturing
 * output, read a container's run-state, and assert the daemon is reachable. */
import { fail } from "../../output.ts";
import { runCapture } from "../../proc.ts";

/** Run `docker <args>`, capturing stdout/stderr + exit code (never rejects).
 * `extraEnv` is merged into the child's environment (used to pass a secret via
 * the process env + `-e NAME` rather than argv, so it never shows in `ps`). */
export const docker = (args: string[], extraEnv?: Record<string, string>) =>
  runCapture(["docker", ...args], extraEnv ? { env: extraEnv } : undefined);

/** Container run-state for `name`: running, stopped, or absent. */
export async function runState(
  name: string,
): Promise<"running" | "stopped" | "absent"> {
  const res = await docker(["inspect", "-f", "{{.State.Running}}", name]);
  if (res.code !== 0) return "absent";
  return res.stdout.trim() === "true" ? "running" : "stopped";
}

/** Fail with an actionable message when the Docker daemon isn't reachable. */
export async function ensureDocker(): Promise<void> {
  const res = await docker(["version", "--format", "{{.Server.Version}}"]);
  if (res.code !== 0) {
    fail(
      "Docker isn't available. Install Docker Desktop / OrbStack / a Linux " +
        "daemon and make sure `docker` is on your PATH.",
    );
  }
}
