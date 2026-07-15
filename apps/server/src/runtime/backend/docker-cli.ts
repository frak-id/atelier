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
 * rejects, so callers branch on `code`). */
export function docker(args: string[], bin = "docker"): Promise<DockerResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args);
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
