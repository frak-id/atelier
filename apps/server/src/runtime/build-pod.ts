/**
 * Throwaway build pods: the boot-run-teardown flow behind prebuild bakes and
 * toolset builds/refreshes, plus the minimal specs those pods boot from.
 */
import type { PrebuildSpec, SandboxSpec } from "@atelier/spec";
import { createChildLogger } from "../shared/lib/logger.ts";
import type { AgentClient } from "./agent/index.ts";
import type { SandboxBackend } from "./backend/index.ts";
import type { BootOutput } from "./boot.ts";

const log = createChildLogger("runtime-build-pod");

/** Optional sink for a long op's live output (wired to the job log by the
 * api/ seam — see `JobService.dispatch`). Kept as a plain callback so the
 * runtime never depends on the jobs layer. */
export type OnLog = (chunk: string) => void;

/** Resources for the throwaway build pods (prebuild bake, toolset build).
 * Under the Kata runtime-rs class the guest gets exactly `memoryMb` of RAM
 * (static sizing); the Go runtime gave it `memoryMb` + a 2 GiB default on top,
 * sized past the pod's cgroup limit, and those pods were OOM-killed whole by
 * the host once page cache filled the guest. 4096 keeps the guest RAM these
 * builds ran with before (2048 + 2048) while the pod limit now really bounds
 * it: a runaway build hits the guest OOM killer, not a host VM kill. */
const BUILD_POD_RESOURCES: SandboxSpec["resources"] = {
  vcpus: 2,
  memoryMb: 4096,
};

/** Synthesize the minimal SandboxSpec the prebuild pod boots from: source +
 * build resources + staged files + build env. No processes/ports (nothing
 * to supervise or expose while baking). */
export function prebuildToSpec(spec: PrebuildSpec): SandboxSpec {
  return {
    source: spec.source,
    resources: BUILD_POD_RESOURCES,
    files: spec.files,
    env: spec.env,
  };
}

/** Synthesize the minimal SandboxSpec a toolset build pod boots from: source +
 * build resources + build env. No processes/ports/files — nothing to
 * supervise or expose while installing tools into the home. */
export function toolsetToSpec(
  source: SandboxSpec["source"],
  env?: Record<string, string>,
): SandboxSpec {
  return {
    source,
    resources: BUILD_POD_RESOURCES,
    ...(env && { env }),
  };
}

export class BuildPods {
  constructor(
    private readonly backend: SandboxBackend,
    private readonly agent: AgentClient,
  ) {}

  /**
   * Boot a throwaway pod for a build-then-teardown flow (prebuild bake,
   * toolset build) and guarantee cleanup: the pod + its PVC are torn down in
   * a `finally` regardless of whether `fn` succeeds, and the pod-IP cache
   * entry is invalidated so a reused `tempId` (deterministic per content
   * hash) never dials a stale IP. `fn` receives the boot output and returns
   * the operation's result, which is threaded straight through. Cleanup
   * itself is best-effort — a teardown failure is logged, never thrown, so
   * it can't mask `fn`'s success or replace its error.
   */
  async withThrowawayPod<T>(
    tempId: string,
    spec: SandboxSpec,
    input: { image: string; snapshotName?: string; toolsets?: string[] },
    cleanupFailureMessage: string,
    fn: (boot: BootOutput) => Promise<T>,
  ): Promise<T> {
    const boot = await this.backend.boot(tempId, spec, input, this.agent);
    try {
      return await fn(boot);
    } finally {
      // The pod + throwaway PVC are no longer needed; whatever `fn` produced
      // (a snapshot, a pushed toolset) stands alone.
      this.agent.invalidatePodIp(tempId);
      await this.backend
        .cleanup(tempId)
        .catch((err) => log.warn({ tempId, err }, cleanupFailureMessage));
    }
  }

  async execStep(
    tempId: string,
    command: string,
    user?: "dev" | "root",
    signal?: AbortSignal,
    onLog?: OnLog,
  ): Promise<void> {
    onLog?.(`$ ${command}`);
    // Run `dev` steps from /home/dev, not the agent's own cwd (which is `/`,
    // root-owned 0755 — dev can't create anything there). Every dev prebuild/
    // toolset step assumes the home it captures: a relative `git clone <repo>
    // <clonePath>` or a `cd <clonePath> && …` build step must resolve under
    // /home/dev, and toolset installs must land in the captured path-sets.
    // The `/exec` route (unlike the terminal, which defaults to SHELL_HOME)
    // inherits the agent's cwd when no workdir is given, so pin it here. Root
    // steps keep inheriting `/` (root can write there; they use absolute paths
    // or sudo).
    const res = await this.agent.exec(tempId, command, {
      timeout: 600_000,
      user,
      workdir: user === "dev" ? "/home/dev" : undefined,
      signal,
    });
    if (res.stdout.trim()) onLog?.(res.stdout.trimEnd());
    if (res.stderr.trim()) onLog?.(res.stderr.trimEnd());
    if (res.exitCode !== 0) {
      onLog?.(`✗ exit ${res.exitCode}`);
      throw new Error(
        `build step failed (exit ${res.exitCode}): ${command}\n${res.stderr.trim()}`,
      );
    }
  }
}
