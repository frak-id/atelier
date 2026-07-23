/** Spawn a new sandbox from within the cockpit: pick a source (this repo's
 * prebuild / a prebuild / a base image), layer on toolboxes, then boot with a
 * live progress log. */
import type { CreateSandboxResponse, PrebuildRecord } from "@atelier/spec";
import pc from "picocolors";
import {
  type AtelierApi,
  type CreateSandboxBody,
  type JobRecord,
  unwrap,
  waitForJob,
} from "../../client.ts";
import {
  deriveClonePath,
  detectGitRepo,
  type GitRepo,
  shortRepo,
} from "../../git.ts";
import { line, printLogDelta } from "../../output.ts";
import * as ui from "../../ui.ts";
import {
  findRepoBranchPrebuild,
  prebuildRepoBranch,
} from "../prebuild-create.ts";
import { prebuildHint } from "./prebuilds.ts";
import { pickToolboxes } from "./toolboxes.ts";

/** Block on a sandbox-create job while streaming its boot progress log. */
async function bootWithLogs(
  api: AtelierApi,
  job: JobRecord,
): Promise<CreateSandboxResponse> {
  line(pc.dim("booting…"));
  let printed = 0;
  return waitForJob<CreateSandboxResponse>(api, job, {
    intervalMs: 900,
    onTick: async (j) => {
      try {
        const { log } = unwrap(await api.v1.jobs({ id: j.id }).logs.get());
        printed = printLogDelta(log, printed);
      } catch {
        // Log endpoint is best-effort; keep polling status.
      }
    },
  });
}

/** Layer on toolboxes, then post + boot a sandbox body with a live progress
 * log. Returns the new sandbox id (throws on boot failure). */
async function bootSandbox(
  api: AtelierApi,
  body: CreateSandboxBody,
): Promise<string> {
  const toolboxes = await pickToolboxes(api);
  const finalBody: CreateSandboxBody =
    toolboxes.length > 0 ? { ...body, toolboxes } : body;
  const job = unwrap(await api.v1.sandboxes.post(finalBody));
  try {
    const result = await bootWithLogs(api, job);
    line(pc.green(`✓ ${result.id} ready`));
    return result.id;
  } catch (err) {
    line(pc.red("boot failed"));
    throw err;
  }
}

interface RepoBoot {
  prebuild: PrebuildRecord;
  /** The prebuild targets this repo AND the checked-out branch. */
  branchMatch: boolean;
  /** Where the repo lives inside the sandbox (for a post-boot git pull). */
  clonePath: string;
}

/** Inside a git checkout, find a prebuild to fast-boot from: an exact
 * repo+branch match first, else any prebuild for the same repo (a different
 * branch, which we'll `git pull` to after boot). Best-effort — null on any
 * failure. */
async function findRepoBoot(
  api: AtelierApi,
  gitRepo: GitRepo,
): Promise<RepoBoot | null> {
  try {
    const rows = unwrap(await api.v1.prebuilds.get());
    const exact = findRepoBranchPrebuild(rows, gitRepo.url, gitRepo.branch);
    const want = shortRepo(gitRepo.url).toLowerCase();
    const match =
      exact ??
      rows.find((p) => {
        const rb = prebuildRepoBranch(p);
        return rb.url && shortRepo(rb.url).toLowerCase() === want;
      });
    if (!match) return null;
    const clonePath =
      match.spec?.repos?.[0]?.clonePath ?? deriveClonePath(gitRepo.url);
    return { prebuild: match, branchMatch: Boolean(exact), clonePath };
  } catch {
    return null;
  }
}

/** After booting from a repo prebuild whose branch differs from the local
 * checkout, fetch + switch to the wanted branch inside the sandbox so it
 * matches the cwd. Best-effort: reports the exec result, never throws. */
async function pullBranchInSandbox(
  api: AtelierApi,
  id: string,
  clonePath: string,
  branch: string,
): Promise<void> {
  const command = `cd ${clonePath} && git fetch --all --prune && git checkout ${branch} && git pull --ff-only`;
  line(pc.dim(`$ ${command}`));
  const s = ui.spinner();
  s.start(`Pulling ${branch}…`);
  try {
    const res = unwrap(await api.v1.sandboxes({ id }).exec.post({ command }));
    s.stop(`git pull exited ${res.exitCode}`);
    if (res.stdout) line(pc.dim(res.stdout.trimEnd()));
    if (res.stderr) line(pc.red(res.stderr.trimEnd()));
  } catch (err) {
    s.stop("git pull failed", 1);
    ui.note(err instanceof Error ? err.message : String(err));
  }
}

/** Spawn a new sandbox from within the cockpit: pick a core (this repo's
 * prebuild / image / prebuild), layer on toolboxes, then boot with a live
 * progress log. */
export async function spawnFlow(api: AtelierApi): Promise<string | null> {
  const gitRepo = detectGitRepo();
  const repoBoot = gitRepo ? await findRepoBoot(api, gitRepo) : null;
  const repoLabel = gitRepo
    ? `${shortRepo(gitRepo.url)}${gitRepo.branch ? `@${gitRepo.branch}` : ""}`
    : "";

  const source = await ui.select<"repo" | "image" | "prebuild" | "cancel">({
    message: "New sandbox from…",
    options: [
      ...(repoBoot && gitRepo
        ? [
            {
              value: "repo" as const,
              label: pc.green(`✦ Boot sandbox for ${repoLabel}`),
              hint: repoBoot.branchMatch
                ? "from this repo's prebuild — deps ready"
                : `prebuild is a different branch — will git pull ${
                    gitRepo.branch ?? "current"
                  } inside`,
            },
          ]
        : []),
      {
        value: "prebuild",
        label: "Prebuild",
        hint: "boot from a repo snapshot you already baked — fast, deps ready",
      },
      {
        value: "image",
        label: "Base image",
        hint: "boot straight from a Docker image ref — empty, no repo",
      },
      { value: "cancel", label: pc.dim("Cancel") },
    ],
  });
  if (source === "cancel") return null;

  // ── fast path: boot from the current repo's prebuild ────────────────────
  if (source === "repo" && repoBoot && gitRepo) {
    const id = await bootSandbox(api, {
      source: { snapshot: repoBoot.prebuild.ref },
      resources: { vcpus: 2, memoryMb: 2048 },
    });
    if (!repoBoot.branchMatch && gitRepo.branch) {
      await pullBranchInSandbox(api, id, repoBoot.clonePath, gitRepo.branch);
    }
    return id;
  }

  // ── 1. core source ──────────────────────────────────────────────────────
  let body: CreateSandboxBody | undefined;
  if (source === "image") {
    const image = await ui.text({
      message: "Image ref",
      placeholder: "ghcr.io/org/dev:latest",
    });
    if (!image.trim()) return null;
    body = {
      source: { image: image.trim() },
      resources: { vcpus: 2, memoryMb: 2048 },
    };
  } else {
    const prebuilds = unwrap(await api.v1.prebuilds.get());
    if (prebuilds.length === 0) {
      ui.note("No prebuilds. Bake one with `atelier prebuild run`.");
      return null;
    }
    const ref = await ui.select<string>({
      message: "Which prebuild?",
      options: prebuilds.map((p) => ({
        value: p.ref,
        label: p.ref,
        hint: prebuildHint(p),
      })),
    });
    body = {
      source: { snapshot: ref },
      resources: { vcpus: 2, memoryMb: 2048 },
    };
  }
  if (!body) return null;

  return bootSandbox(api, body);
}
