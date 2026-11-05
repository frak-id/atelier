/**
 * The branch switch of a spawn with no bake of its branch: the plan read off
 * the default-branch prebuild, the checkout shell (run against a real git
 * remote, since the command IS the contract), and the warning-only
 * checkout/setup steps over a fake runtime.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type PrebuildRecord,
  SANDBOX_CHECKOUT_ANNOTATION,
} from "@atelier/spec";
import {
  type BranchSwitch,
  branchCheckoutCommand,
  branchSetupLabel,
  checkoutBranch,
  planBranchSwitch,
  runBranchSetup,
} from "./branch-setup.ts";

const URL = "https://github.com/frak-id/wallet";

function bake(
  ref: string,
  repos: { url: string; branch?: string; clonePath: string }[],
  build?: string[],
): PrebuildRecord {
  return {
    ref,
    hash: `h-${ref}`,
    image: "dev-base:latest",
    createdAt: "2026-01-01T00:00:00.000Z",
    spec: { source: { image: "dev-base" }, repos, ...(build ? { build } : {}) },
  };
}

describe("planBranchSwitch", () => {
  const surfaces: Record<string, { processes?: { name: string }[] }> = {
    "snap-multi": { processes: [{ name: "web" }, { name: "api" }] },
  };
  const runtime = {
    prebuildSurface: (ref: string) => surfaces[ref] ?? {},
  } as never;

  test("switches the base's clone, wherever it sits", () => {
    const multi = bake(
      "snap-multi",
      [
        { url: "https://github.com/frak-id/landing", clonePath: "landing" },
        { url: `${URL}.git`, clonePath: "code/wallet" },
      ],
      ["cd code/wallet && bun install", "cd landing && bun install"],
    );
    expect(planBranchSwitch(runtime, multi, URL, " feature/x ")).toEqual({
      baseRef: "snap-multi",
      url: URL,
      branch: "feature/x",
      clonePath: "code/wallet",
      build: ["cd code/wallet && bun install", "cd landing && bun install"],
      devServers: ["web", "api"],
    });
  });

  test("nothing to switch: no branch, another repo, or already on it", () => {
    const main = bake("snap-main", [
      { url: URL, branch: "main", clonePath: "wallet" },
    ]);
    expect(planBranchSwitch(runtime, main, URL, undefined)).toBeUndefined();
    expect(planBranchSwitch(runtime, main, URL, " ")).toBeUndefined();
    expect(
      planBranchSwitch(runtime, main, "https://github.com/a/b", "x"),
    ).toBeUndefined();
    expect(planBranchSwitch(runtime, main, URL, "main")).toBeUndefined();
    expect(planBranchSwitch(runtime, main, URL, "x")?.build).toEqual([]);
  });
});

/** Run `script` in `cwd` with bash; resolves stdout, rejects on failure. */
async function sh(script: string, cwd: string): Promise<string> {
  const proc = Bun.spawn(["bash", "-c", script], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`exit ${code}: ${err}`);
  return out.trim();
}

describe("branchCheckoutCommand", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  test("moves a shallow single-branch clone to a tracking branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "atelier-checkout-"));
    dirs.push(root);
    const git = "git -c user.email=t@t -c user.name=t";
    await sh(
      [
        "git init -q -b main origin",
        "cd origin",
        `echo 1 > a && git add a && ${git} commit -qm one`,
        'git checkout -qb "feat/it\'s"',
        `echo 2 > b && git add b && ${git} commit -qm two`,
        "git checkout -q main",
        // The bake's clone: shallow, so it only tracks `main`.
        `cd .. && mkdir home && git clone -q --depth 1 "file://${root}/origin" home/wallet`,
      ].join(" && "),
      root,
    );
    const home = join(root, "home");
    const command = branchCheckoutCommand("wallet", "feat/it's");
    await sh(command, home);
    expect(await sh("git -C wallet status -sb | head -1", home)).toBe(
      "## feat/it's...origin/feat/it's",
    );
    expect(await sh("ls wallet", home)).toBe("a\nb");

    // Running it again changes nothing (no duplicate refspec).
    await sh(command, home);
    expect(
      (await sh("git -C wallet config --get-all remote.origin.fetch", home))
        .split("\n")
        .sort(),
    ).toEqual([
      "+refs/heads/feat/it's:refs/remotes/origin/feat/it's",
      "+refs/heads/main:refs/remotes/origin/main",
    ]);

    // The branch follows its remote: a later `git pull` brings new commits.
    await sh(
      `cd origin && git checkout -q "feat/it's" && echo 3 > c && git add c && ${git} commit -qm three`,
      root,
    );
    await sh("git -C wallet pull -q", home);
    expect(await sh("ls wallet", home)).toBe("a\nb\nc");

    await expect(
      sh(branchCheckoutCommand("wallet", "nope"), home),
    ).rejects.toThrow("couldn't find remote ref");
  });
});

const PLAN: BranchSwitch = {
  baseRef: "snap-default",
  url: URL,
  branch: "feature/x",
  clonePath: "wallet",
  build: ["cd wallet && bun install", "cd wallet && bun run build"],
  devServers: ["web", "lazy-docs"],
};

type Exec = { exitCode: number; stdout: string; stderr: string };

/** A runtime whose `exec` answers from `answer` (or throws its Error). */
function fakeRuntime(answer: (command: string) => Exec | Error = () => ok) {
  const calls = {
    exec: [] as { command: string; cwd?: string; timeoutMs?: number }[],
    annotations: [] as [string, string | undefined][],
    processActions: [] as string[],
  };
  let failRestart: string | undefined;
  const runtime = {
    exec: async (
      _id: string,
      req: { command: string; cwd?: string; timeoutMs?: number },
    ) => {
      calls.exec.push(req);
      const res = answer(req.command);
      if (res instanceof Error) throw res;
      return res;
    },
    setAnnotation: (_id: string, key: string, value: string | undefined) => {
      calls.annotations.push([key, value]);
    },
    get: async () => ({
      processes: [
        { name: "opencode", running: true, primary: true },
        { name: "web", running: true },
        { name: "lazy-docs", running: false },
      ],
    }),
    processAction: async (_id: string, name: string, action: string) => {
      if (name === failRestart) throw new Error("agent down");
      calls.processActions.push(`${action}:${name}`);
    },
  };
  return {
    runtime: runtime as never,
    calls,
    failRestartOf: (name: string) => {
      failRestart = name;
    },
  };
}

const ok: Exec = { exitCode: 0, stdout: "", stderr: "" };

describe("checkoutBranch", () => {
  test("checks out from the home and records the branch", async () => {
    const { runtime, calls } = fakeRuntime();
    const progress: string[] = [];
    const warning = await checkoutBranch(runtime, "sb", PLAN, (m) =>
      progress.push(m),
    );
    expect(warning).toBeUndefined();
    expect(calls.exec).toEqual([
      {
        command: branchCheckoutCommand("wallet", "feature/x"),
        cwd: "/home/dev",
        timeoutMs: 120_000,
      },
    ]);
    expect(calls.annotations).toEqual([
      [SANDBOX_CHECKOUT_ANNOTATION, `${URL}#feature/x`],
    ]);
    expect(progress).toEqual(["switching wallet to feature/x…"]);
  });

  test("a failed checkout is a warning and records nothing", async () => {
    const failing = fakeRuntime(() => ({
      exitCode: 128,
      stdout: "",
      stderr: "remote: hi\nfatal: couldn't find remote ref refs/heads/x\n",
    }));
    expect(await checkoutBranch(failing.runtime, "sb", PLAN, () => {})).toBe(
      "Could not switch frak-id/wallet to feature/x (fatal: couldn't find " +
        "remote ref refs/heads/x); the sandbox is on the default branch.",
    );
    expect(failing.calls.annotations).toEqual([]);

    const down = fakeRuntime(() => new Error("agent unreachable"));
    expect(await checkoutBranch(down.runtime, "sb", PLAN, () => {})).toContain(
      "(agent unreachable)",
    );
  });

  test("an implausible branch name never reaches the shell", async () => {
    for (const branch of ["-f", "a b", "a..b", "x.lock", "x/", "$(id)"]) {
      const { runtime, calls } = fakeRuntime();
      const warning = await checkoutBranch(
        runtime,
        "sb",
        { ...PLAN, branch },
        () => {},
      );
      // `$(id)` is a legal branch name: quoted, it is passed as-is.
      if (branch === "$(id)") {
        expect(warning).toBeUndefined();
        expect(calls.exec[0]?.command).toContain("'+refs/heads/$(id):");
      } else {
        expect(warning).toContain("(invalid branch name)");
        expect(calls.exec).toEqual([]);
      }
    }
  });
});

describe("runBranchSetup", () => {
  test("runs every step, then restarts the running dev servers", async () => {
    const { runtime, calls } = fakeRuntime((command) =>
      command.includes("install")
        ? { exitCode: 0, stdout: "added 12 packages\n", stderr: "" }
        : ok,
    );
    const log: string[] = [];
    const result = await runBranchSetup(runtime, "sb", PLAN, (c) =>
      log.push(c),
    );
    expect(result).toEqual({ branch: "feature/x" });
    expect(calls.exec).toEqual(
      PLAN.build.map((command) => ({
        command,
        cwd: "/home/dev",
        timeoutMs: 600_000,
      })),
    );
    // Only a dev server that runs: never the harness, never a lazy one.
    expect(calls.processActions).toEqual(["stop:web", "start:web"]);
    expect(log).toEqual([
      "$ cd wallet && bun install",
      "added 12 packages",
      "$ cd wallet && bun run build",
      "Restarting web…",
      "wallet is set up on feature/x.",
    ]);
  });

  test("a failing step stops the run with a warning", async () => {
    const { runtime, calls } = fakeRuntime((command) =>
      command.includes("install")
        ? { exitCode: 1, stdout: "", stderr: "lockfile mismatch" }
        : ok,
    );
    const log: string[] = [];
    const result = await runBranchSetup(runtime, "sb", PLAN, (c) =>
      log.push(c),
    );
    const warning =
      "Build step failed after switching to feature/x: cd wallet && bun " +
      "install (exit 1). Dependencies may be out of date.";
    expect(result).toEqual({ branch: "feature/x", warnings: [warning] });
    expect(calls.exec).toHaveLength(1);
    expect(calls.processActions).toEqual([]);
    expect(log).toContain("lockfile mismatch");
    expect(log.at(-1)).toBe(`✗ ${warning}`);
  });

  test("a step that cannot run, or a failed restart, is a warning", async () => {
    const gone = fakeRuntime(() => new Error("Sandbox sb not found"));
    expect(
      (await runBranchSetup(gone.runtime, "sb", PLAN, () => {})).warnings,
    ).toEqual([
      "Build step failed after switching to feature/x: cd wallet && bun " +
        "install (Sandbox sb not found). Dependencies may be out of date.",
    ]);

    const restart = fakeRuntime();
    restart.failRestartOf("web");
    expect(await runBranchSetup(restart.runtime, "sb", PLAN, () => {})).toEqual(
      {
        branch: "feature/x",
        warnings: ["Could not restart web (agent down)."],
      },
    );
  });
});

test("branchSetupLabel", () => {
  expect(branchSetupLabel(PLAN)).toBe("frak-id/wallet#feature/x");
});
