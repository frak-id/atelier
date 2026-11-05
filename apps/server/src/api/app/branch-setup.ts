/**
 * Spawning a repo on a branch nobody baked: boot from the repo's
 * default-branch prebuild instead of baking a new one, switch its clone to
 * the branch before any process starts, then re-run the prebuild's build
 * steps in the live sandbox (a `sandbox-setup` job) while the caller already
 * works in it. The snapshot holds the clone and the installed dependencies,
 * so the checkout is one shallow fetch and the re-run is incremental.
 *
 * Every failure is a warning, never a failed spawn: a failed checkout leaves
 * the sandbox on the default branch, a failed step leaves its dependencies as
 * the prebuild baked them. The steps run as `dev` from the home like a bake,
 * but with the sandbox's env: the prebuild's build-only `env` may hold values
 * the spawning user must not read, so it never enters their sandbox.
 */
import {
  findRepoBasePrebuild,
  type PrebuildRecord,
  prebuildRepoFor,
  repoShortName,
  SANDBOX_CHECKOUT_ANNOTATION,
} from "@atelier/spec";
import { VM } from "../../config/constants.ts";
import type { RuntimeService } from "../../runtime/index.ts";

/** One build step's budget, the same as in a bake (`BuildPods.execStep`). */
const BUILD_STEP_TIMEOUT_MS = 600_000;
/** The checkout's budget: one shallow fetch of one branch. */
const CHECKOUT_TIMEOUT_MS = 120_000;

type SetupRuntime = Pick<
  RuntimeService,
  "exec" | "get" | "processAction" | "setAnnotation"
>;

/** What a spawn boots from and does to land on `branch` (see the module
 * doc). */
export interface BranchSwitch {
  /** The default-branch prebuild the sandbox boots from. */
  baseRef: string;
  url: string;
  branch: string;
  /** Where that prebuild cloned the repo, relative to the dev home. */
  clonePath: string;
  /** The prebuild's whole `build[]`, re-run once the branch is checked out. */
  build: string[];
  /** Its dev servers (process names), restarted after the steps succeed:
   * they started on the default branch's dependencies. */
  devServers: string[];
}

/**
 * The switch for a spawn of `url` on `branch` from `records` (already
 * narrowed to the requested base image), or `undefined` when there is no
 * default-branch prebuild to start from (or nothing to switch to).
 */
export function planBranchSwitch(
  runtime: Pick<RuntimeService, "prebuildSurface">,
  records: readonly PrebuildRecord[],
  url: string,
  branch: string | undefined,
): BranchSwitch | undefined {
  const base = findRepoBasePrebuild(records, url, branch);
  const clone = base && prebuildRepoFor(base, url);
  const target = branch?.trim();
  if (!base || !clone || !target) return undefined;
  return {
    baseRef: base.ref,
    url,
    branch: target,
    clonePath: clone.clonePath,
    build: base.spec?.build ?? [],
    devServers: (runtime.prebuildSurface(base.ref).processes ?? []).map(
      (p) => p.name,
    ),
  };
}

/** The setup job's feed label, e.g. `frak-id/wallet#feature/x`. */
export function branchSetupLabel(plan: BranchSwitch): string {
  return `${repoShortName(plan.url)}#${plan.branch}`;
}

function shQuote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/** What git accepts as a branch name, minus what could pass for an option.
 * Anything else git still rejects on its own. */
function isPlausibleBranch(branch: string): boolean {
  return (
    !branch.startsWith("-") &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this rejects
    !/[\s\x00-\x1f\x7f~^:?*[\\]|\.\.|@\{/.test(branch) &&
    !/(^|\/)\.|\.lock$|[/.]$/.test(branch)
  );
}

/**
 * The shell that moves the clone at `clonePath` to `branch`. The bake's clone
 * is `--depth 1` and so tracks only its own branch: add this one to the
 * fetch refspec (once), fetch its tip shallowly, and check it out tracking
 * `origin/<branch>`, so a later `git pull` or `git push` just works.
 */
export function branchCheckoutCommand(
  clonePath: string,
  branch: string,
): string {
  const tracking = `refs/remotes/origin/${branch}`;
  const refspec = shQuote(`+refs/heads/${branch}:${tracking}`);
  return [
    `cd ${shQuote(clonePath)}`,
    `{ git config --get-all remote.origin.fetch | grep -qxF ${refspec} || git config --add remote.origin.fetch ${refspec}; }`,
    `git fetch --depth 1 origin ${refspec}`,
    `git checkout -B ${shQuote(branch)} ${shQuote(tracking)} --`,
  ].join(" && ");
}

function lastLine(text: string): string | undefined {
  return text.trim().split("\n").pop()?.trim() || undefined;
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Check the branch out in the booted guest (`beforeProcesses` of the create)
 * and record it on the sandbox (`SANDBOX_CHECKOUT_ANNOTATION`). Never
 * throws: returns the warning when the sandbox stays on the default branch.
 */
export async function checkoutBranch(
  runtime: SetupRuntime,
  id: string,
  plan: BranchSwitch,
  onProgress: (msg: string) => void,
): Promise<string | undefined> {
  const failed = (why: string) =>
    `Could not switch ${repoShortName(plan.url)} to ${plan.branch} (${why}); ` +
    "the sandbox is on the default branch.";
  if (!isPlausibleBranch(plan.branch)) return failed("invalid branch name");
  onProgress(`switching ${plan.clonePath} to ${plan.branch}…`);
  try {
    const res = await runtime.exec(id, {
      command: branchCheckoutCommand(plan.clonePath, plan.branch),
      cwd: VM.HOME,
      timeoutMs: CHECKOUT_TIMEOUT_MS,
    });
    if (res.exitCode !== 0) {
      return failed(lastLine(res.stderr) ?? `exit ${res.exitCode}`);
    }
  } catch (err) {
    return failed(reason(err));
  }
  runtime.setAnnotation(
    id,
    SANDBOX_CHECKOUT_ANNOTATION,
    `${plan.url}#${plan.branch}`,
  );
  return undefined;
}

/** What a `sandbox-setup` job settles with (its feed `result`). */
export interface BranchSetupResult {
  branch: string;
  /** Set when a step or a dev-server restart failed. */
  warnings?: string[];
}

/**
 * The `sandbox-setup` job body: run the prebuild's build steps in the live
 * sandbox, fail-fast like a bake, streaming their output to the job log,
 * then restart the dev servers that are running. Never throws.
 */
export async function runBranchSetup(
  runtime: SetupRuntime,
  id: string,
  plan: BranchSwitch,
  log: (chunk: string) => void,
): Promise<BranchSetupResult> {
  const warn = (warning: string): BranchSetupResult => {
    log(`✗ ${warning}`);
    return { branch: plan.branch, warnings: [warning] };
  };
  const stepFailed = (step: string, why: string) =>
    `Build step failed after switching to ${plan.branch}: ${step} (${why}). ` +
    "Dependencies may be out of date.";
  for (const step of plan.build) {
    log(`$ ${step}`);
    let res: Awaited<ReturnType<SetupRuntime["exec"]>>;
    try {
      res = await runtime.exec(id, {
        command: step,
        cwd: VM.HOME,
        timeoutMs: BUILD_STEP_TIMEOUT_MS,
      });
    } catch (err) {
      return warn(stepFailed(step, reason(err)));
    }
    if (res.stdout.trim()) log(res.stdout.trimEnd());
    if (res.stderr.trim()) log(res.stderr.trimEnd());
    if (res.exitCode !== 0) {
      return warn(stepFailed(step, `exit ${res.exitCode}`));
    }
  }
  const warnings = await restartDevServers(runtime, id, plan.devServers, log);
  log(`${plan.clonePath} is set up on ${plan.branch}.`);
  return { branch: plan.branch, ...(warnings.length > 0 ? { warnings } : {}) };
}

/** Restart the running ones of `names`; a lazy dev server nobody opened yet
 * starts on the new dependencies by itself. Returns the failures. */
async function restartDevServers(
  runtime: SetupRuntime,
  id: string,
  names: string[],
  log: (chunk: string) => void,
): Promise<string[]> {
  if (names.length === 0) return [];
  const warnings: string[] = [];
  let running: string[];
  try {
    running = (await runtime.get(id)).processes
      .filter((p) => p.running && names.includes(p.name))
      .map((p) => p.name);
  } catch (err) {
    return [`Could not restart the dev servers (${reason(err)}).`];
  }
  for (const name of running) {
    log(`Restarting ${name}…`);
    try {
      await runtime.processAction(id, name, "stop");
      await runtime.processAction(id, name, "start");
    } catch (err) {
      const warning = `Could not restart ${name} (${reason(err)}).`;
      log(`✗ ${warning}`);
      warnings.push(warning);
    }
  }
  return warnings;
}
