/**
 * Preparing a spawn's repo in the live sandbox instead of baking a prebuild
 * for it. Two plans:
 *  - switch: the branch has no bake, but the repo does (its default branch's
 *    first, `findRepoBasePrebuild`). Boot that one and move its clone to the
 *    branch; its build steps then re-run on the dependencies it holds.
 *  - clone: the repo has no bake at all and the caller asked for none
 *    (`repo.bake: false`). Boot the bare image and clone the repo into the
 *    home; the caller's setup steps then run in the clone.
 * Either way the repo is ready before any process starts (`prepareRepo`, the
 * create's `beforeProcesses`), so neither a dev server nor an agent sees the
 * wrong tree, and the steps run as a `sandbox-setup` job once the sandbox is
 * up (`runRepoSetup`), while the caller already works in it.
 *
 * Every failure is a warning, never a failed spawn: a failed switch leaves
 * the prebuild's branch, a failed clone an empty home, a failed step the
 * dependencies as they were. The steps run as `dev` from the home like a
 * bake, but with the sandbox's env: a prebuild's build-only `env` may hold
 * values the spawning user must not read, so it never enters their sandbox.
 */
import {
  buildRepoPrebuildSpec,
  type PrebuildRecord,
  prebuildRepoFor,
  repoShortName,
  SANDBOX_CHECKOUT_ANNOTATION,
} from "@atelier/spec";
import { VM } from "../../config/constants.ts";
import type { RuntimeService } from "../../runtime/index.ts";

/** One build step's budget, the same as in a bake (`BuildPods.execStep`). */
const BUILD_STEP_TIMEOUT_MS = 600_000;
/** The checkout's or clone's budget: one shallow fetch of one branch. */
const CHECKOUT_TIMEOUT_MS = 120_000;

type SetupRuntime = Pick<
  RuntimeService,
  "exec" | "get" | "processAction" | "setAnnotation"
>;

/** Boot `baseRef` and move its clone of `url` to `branch`. */
export interface BranchSwitch {
  mode: "switch";
  /** The prebuild the sandbox boots from. */
  baseRef: string;
  url: string;
  branch: string;
  /** Where that prebuild cloned the repo, relative to the dev home. */
  clonePath: string;
  /** The prebuild's whole `build[]`, re-run once the branch is checked out. */
  build: string[];
  /** Its dev servers (process names), restarted after the steps succeed:
   * they started on the dependencies of the prebuild's branch. */
  devServers: string[];
}

/** Clone `url` (on `branch`, else its default branch) into the bare image. */
interface RepoClone {
  mode: "clone";
  url: string;
  branch?: string;
  clonePath: string;
  /** The caller's setup steps, each scoped to the clone (`cd` into it). */
  build: string[];
  devServers: [];
}

export type RepoSetup = BranchSwitch | RepoClone;

/**
 * The switch of `base`'s clone of `url` to `branch`, or `undefined` when
 * `base` does not clone `url`, no branch is named, or the clone is already
 * on it (nothing to switch).
 */
export function planBranchSwitch(
  runtime: Pick<RuntimeService, "prebuildSurface">,
  base: PrebuildRecord,
  url: string,
  branch: string | undefined,
): BranchSwitch | undefined {
  const clone = prebuildRepoFor(base, url);
  const target = branch?.trim();
  if (!clone || !target || clone.branch?.trim() === target) return undefined;
  return {
    mode: "switch",
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

/** The clone of `url` at boot, laid out like a quick prebuild of it
 * (`buildRepoPrebuildSpec`: the repo's name as the clone path, each setup
 * step scoped to it), so a later prebuild of the repo looks the same. */
export function planRepoClone(
  url: string,
  branch: string | undefined,
  setup: readonly string[] = [],
): RepoClone {
  const recipe = buildRepoPrebuildSpec({
    repo: url,
    branch,
    image: "",
    build: [...setup],
  });
  const repo = recipe.repos?.[0];
  return {
    mode: "clone",
    url: repo?.url ?? url,
    ...(repo?.branch ? { branch: repo.branch } : {}),
    clonePath: repo?.clonePath ?? "repo",
    build: recipe.build ?? [],
    devServers: [],
  };
}

/** The setup job's feed label, e.g. `frak-id/wallet#feature/x`. */
export function repoSetupLabel(plan: RepoSetup): string {
  const name = repoShortName(plan.url);
  return plan.branch ? `${name}#${plan.branch}` : name;
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

/** The shell that clones `url` into `clonePath`, as a bake does. */
export function repoCloneCommand(
  url: string,
  clonePath: string,
  branch?: string,
): string {
  const at = branch ? `-b ${shQuote(branch)} ` : "";
  return `git clone --depth 1 ${at}-- ${shQuote(url)} ${shQuote(clonePath)}`;
}

function lastLine(text: string): string | undefined {
  return text.trim().split("\n").pop()?.trim() || undefined;
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Get the repo ready in the booted guest (`beforeProcesses` of the create):
 * switch or clone it, then record it on the sandbox
 * (`SANDBOX_CHECKOUT_ANNOTATION`). Never throws: returns the warning when it
 * failed (the sandbox keeps the prebuild's branch, or has no clone).
 */
export async function prepareRepo(
  runtime: SetupRuntime,
  id: string,
  plan: RepoSetup,
  onProgress: (msg: string) => void,
): Promise<string | undefined> {
  const name = repoShortName(plan.url);
  const failed = (why: string) =>
    plan.mode === "switch"
      ? `Could not switch ${name} to ${plan.branch} (${why}); the sandbox ` +
        "is on the prebuild's branch."
      : `Could not clone ${name} (${why}); the sandbox starts without it.`;
  if (plan.branch !== undefined && !isPlausibleBranch(plan.branch)) {
    return failed("invalid branch name");
  }
  onProgress(
    plan.mode === "switch"
      ? `switching ${plan.clonePath} to ${plan.branch}…`
      : `cloning ${name} into ${plan.clonePath}…`,
  );
  try {
    const res = await runtime.exec(id, {
      command:
        plan.mode === "switch"
          ? branchCheckoutCommand(plan.clonePath, plan.branch)
          : repoCloneCommand(plan.url, plan.clonePath, plan.branch),
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
    plan.branch ? `${plan.url}#${plan.branch}` : plan.url,
  );
  return undefined;
}

/** What a `sandbox-setup` job settles with (its feed `result`). */
export interface RepoSetupResult {
  branch?: string;
  /** Set when a step or a dev-server restart failed. */
  warnings?: string[];
}

/**
 * The `sandbox-setup` job body: run the plan's steps in the live sandbox,
 * fail-fast like a bake, streaming their output to the job log, then
 * restart the dev servers that are running. Never throws.
 */
export async function runRepoSetup(
  runtime: SetupRuntime,
  id: string,
  plan: RepoSetup,
  log: (chunk: string) => void,
): Promise<RepoSetupResult> {
  const branch = plan.branch ? { branch: plan.branch } : {};
  const warn = (warning: string): RepoSetupResult => {
    log(`✗ ${warning}`);
    return { ...branch, warnings: [warning] };
  };
  const stepFailed = (step: string, why: string) =>
    (plan.mode === "switch"
      ? `Build step failed after switching to ${plan.branch}`
      : `Setup step failed in ${plan.clonePath}`) +
    `: ${step} (${why}). Dependencies may be missing or out of date.`;
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
  log(
    plan.branch
      ? `${plan.clonePath} is set up on ${plan.branch}.`
      : `${plan.clonePath} is set up.`,
  );
  return { ...branch, ...(warnings.length > 0 ? { warnings } : {}) };
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
