/** Bake a prebuild straight from a git repo + branch — the multi-step flow
 * shared by the cockpit's Prebuilds panel and `atelier prebuild create`.
 *
 * Steps: validate the repo URL → pick a ready base image → pick the branch
 * (defaulting to the checked-out one) → choose a clone path → pick/enter setup
 * commands → confirm → bake. Seeded with the detected local repo so, inside a
 * checkout, every step is a one-keystroke accept. */
import type { PrebuildRecord, PrebuildSpec } from "@atelier/spec";
import pc from "picocolors";
import { type AtelierApi, type ImageRow, unwrap } from "../client.ts";
import { detectSetupSteps } from "../detect.ts";
import {
  deriveClonePath,
  type GitRepo,
  listBranches,
  shortRepo,
} from "../git.ts";
import { fail } from "../output.ts";
import * as ui from "../ui.ts";
import { runPrebuild } from "./sandbox.ts";

/** Accept https(s) and scp-style git@host:owner/repo URLs. */
const REPO_URL_RE = /^(https?:\/\/|git@|ssh:\/\/|git:\/\/).+/i;

const CUSTOM = "__custom__";

/** The repo + branch a prebuild targets, read from its spec first (authoritative)
 * then falling back to the opaque metadata the console stamps. */
export function prebuildRepoBranch(p: PrebuildRecord): {
  url?: string;
  branch?: string;
} {
  const url =
    p.spec?.repos?.[0]?.url ?? p.metadata?.repo ?? p.metadata?.workspace;
  const branch = p.spec?.repos?.[0]?.branch ?? p.metadata?.branch;
  return { url, branch };
}

/** Find an existing prebuild that already covers this repo + branch. Repos are
 * compared by normalized `owner/name`; branches by exact string, where an
 * undefined branch on either side means "the default branch". */
export function findRepoBranchPrebuild(
  rows: PrebuildRecord[],
  url: string,
  branch?: string,
): PrebuildRecord | undefined {
  const wantRepo = shortRepo(url).toLowerCase();
  const wantBranch = branch?.trim() || undefined;
  return rows.find((p) => {
    const rb = prebuildRepoBranch(p);
    if (!rb.url) return false;
    if (shortRepo(rb.url).toLowerCase() !== wantRepo) return false;
    return (rb.branch?.trim() || undefined) === wantBranch;
  });
}

interface SpecInput {
  repo: string;
  branch?: string;
  image: string;
  clonePath: string;
  /** Raw setup commands; each is scoped to `clonePath` (see `inRepoDir`). */
  build?: string[];
}

/** Build steps run as `dev` from the home dir in a fresh shell each — so a bare
 * `npm ci` would miss the repo. Prefix each with `cd <clonePath> &&` unless the
 * user already cd'd somewhere themselves. */
function inRepoDir(step: string, clonePath: string): string {
  return /^\s*cd\s/.test(step) ? step : `cd ${clonePath} && ${step}`;
}

/** Assemble the PrebuildSpec: boot from `image`, clone `repo@branch` into
 * `clonePath`, run the (repo-scoped) build steps, and stamp repo/branch
 * metadata so the listing can recognize it later (and `findRepoBranchPrebuild`
 * can dedupe). */
export function buildPrebuildSpec(input: SpecInput): PrebuildSpec {
  const metadata: Record<string, string> = { repo: input.repo };
  if (input.branch) metadata.branch = input.branch;
  const build = (input.build ?? [])
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => inRepoDir(s, input.clonePath));
  return {
    source: { image: input.image },
    repos: [
      {
        url: input.repo,
        ...(input.branch ? { branch: input.branch } : {}),
        clonePath: input.clonePath,
      },
    ],
    ...(build.length > 0 ? { build } : {}),
    metadata,
  };
}

/** Ready base images the prebuild can boot from. */
async function readyImages(api: AtelierApi): Promise<ImageRow[]> {
  const rows = unwrap(await api.v1.images.get());
  return rows.filter((i) => i.status === "ready");
}

export interface PrebuildCreateSeed {
  repo?: string;
  branch?: string;
  image?: string;
  clonePath?: string;
  /** Local checkout, when detected — powers the branch picker + defaults. */
  gitRepo?: GitRepo;
  force?: boolean;
}

/** Interactive, multi-step "bake a prebuild from a repo" flow. Every field is
 * seeded from `seed` (typically the detected local checkout / CLI flags) so
 * the happy path is a series of confirmations. Bakes on confirm. */
export async function createPrebuildInteractive(
  api: AtelierApi,
  seed: PrebuildCreateSeed = {},
): Promise<void> {
  // ── 1. repo URL ───────────────────────────────────────────────────────────
  const repo = (
    await ui.text({
      message: "Repository URL to bake",
      placeholder: "https://github.com/owner/repo.git",
      initialValue: seed.repo ?? "",
      validate: (v) =>
        !v.trim()
          ? "required"
          : REPO_URL_RE.test(v.trim())
            ? undefined
            : "expected an https:// or git@ clone URL",
    })
  ).trim();
  if (!repo) return;

  // ── 2. base image ─────────────────────────────────────────────────────────
  const images = await readyImages(api).catch(() => [] as ImageRow[]);
  if (images.length === 0) {
    ui.note(
      "No ready base images. Build one first (Base images menu or `atelier image build`).",
    );
    return;
  }
  const image = await ui.select<string>({
    message: "Base image to boot the prebuild from",
    initialValue: seed.image,
    options: images.map((i) => ({
      value: i.ref ?? i.name,
      label: i.name,
      hint: [i.provenance, i.ref].filter(Boolean).join(" · "),
    })),
  });

  // ── 3. branch (default: current checkout) ─────────────────────────────────
  const branch = await pickBranch(seed);

  // ── 4. clone path ─────────────────────────────────────────────────────────
  const clonePath = (
    await ui.text({
      message: "Clone path inside the sandbox",
      initialValue: seed.clonePath ?? deriveClonePath(repo),
      validate: (v) => (v.trim() ? undefined : "required"),
    })
  ).trim();
  if (!clonePath) return;

  // ── 5. setup commands (best-effort detection + manual) ────────────────────
  const build = await pickBuildSteps(seed, repo);

  // ── 6. confirm ────────────────────────────────────────────────────────────
  ui.note(
    [
      `repo:   ${shortRepo(repo)}`,
      `branch: ${branch ?? pc.dim("(default)")}`,
      `image:  ${image}`,
      `path:   ${clonePath}`,
      `setup:  ${build.length > 0 ? build.join(" ; ") : pc.dim("(none)")}`,
    ].join("\n"),
    "Prebuild to bake",
  );
  const yes = await ui.confirm({ message: "Bake this prebuild?" });
  if (!yes) return;

  // ── 7. bake ───────────────────────────────────────────────────────────────
  const spec = buildPrebuildSpec({ repo, branch, image, clonePath, build });
  const s = ui.spinner();
  s.start("Baking prebuild…");
  try {
    const out = await runPrebuild(api, spec, seed.force ?? false);
    s.stop(`Baked ${out.ref}`);
  } catch (err) {
    s.stop("Bake failed", 1);
    ui.note(err instanceof Error ? err.message : String(err));
  }
}

/** Branch step: offer the checkout's branches (current one preselected) plus a
 * "custom" escape hatch; when git can't enumerate any, fall back to free text. */
async function pickBranch(
  seed: PrebuildCreateSeed,
): Promise<string | undefined> {
  const current = seed.branch ?? seed.gitRepo?.branch;
  const branches = seed.gitRepo ? listBranches(seed.gitRepo.root) : [];
  if (branches.length === 0) {
    const typed = (
      await ui.text({
        message: "Branch (blank = default)",
        initialValue: current ?? "",
        defaultValue: "",
      })
    ).trim();
    return typed || undefined;
  }
  const picked = await ui.select<string>({
    message: "Branch to bake",
    initialValue: current && branches.includes(current) ? current : branches[0],
    options: [
      ...branches.map((b) => ({
        value: b,
        label: b === current ? `${b} ${pc.dim("(current)")}` : b,
      })),
      { value: CUSTOM, label: pc.dim("Custom…") },
    ],
  });
  if (picked !== CUSTOM) return picked;
  const typed = (
    await ui.text({
      message: "Branch name",
      initialValue: current ?? "",
      validate: (v) => (v.trim() ? undefined : "required"),
    })
  ).trim();
  return typed || undefined;
}

/** Setup-command step: sniff the local checkout for install commands, let the
 * user keep/drop each (all preselected), then loop for any manual extras. The
 * repo-dir prefix is added later in `buildPrebuildSpec`, so these stay bare. */
async function pickBuildSteps(
  seed: PrebuildCreateSeed,
  repo: string,
): Promise<string[]> {
  // Only trust local detection when the seed checkout is actually this repo —
  // a `--repo` pointing elsewhere must not inherit the cwd's lockfiles.
  const sameRepo =
    seed.gitRepo &&
    shortRepo(seed.gitRepo.url).toLowerCase() === shortRepo(repo).toLowerCase();
  const detected =
    sameRepo && seed.gitRepo ? detectSetupSteps(seed.gitRepo.root) : [];

  const steps: string[] = [];
  if (detected.length > 0) {
    const chosen = await ui.multiselect<string>({
      message: "Detected setup commands — keep the ones to bake",
      required: false,
      initialValues: detected,
      options: detected.map((c) => ({ value: c, label: c })),
    });
    steps.push(...chosen);
  }

  // Manual extras (also the only path when nothing was detected).
  while (true) {
    const more = (
      await ui.text({
        message:
          steps.length > 0
            ? "Add another setup command (blank to finish)"
            : "Setup command to run (blank for none)",
        placeholder: "npm run build",
        defaultValue: "",
      })
    ).trim();
    if (!more) break;
    steps.push(more);
  }
  return steps;
}

/** Non-interactive bake from resolved flags (CLI, `--json`, or no TTY). Fails
 * fast when a required field can't be resolved. Returns the snapshot ref. */
export async function createPrebuildFromArgs(
  api: AtelierApi,
  args: {
    repo?: string;
    branch?: string;
    image?: string;
    clonePath?: string;
    force?: boolean;
    /** Explicit setup commands. When omitted, `detect` may supply them. */
    build?: string[];
    /** Local checkout to sniff for setup commands when `build` is empty. */
    detect?: GitRepo;
  },
): Promise<{ ref: string; hash: string }> {
  const repo = args.repo?.trim();
  if (!repo)
    fail("prebuild create needs --repo <url> (or run inside a git repo)");
  if (!REPO_URL_RE.test(repo)) {
    fail(`--repo must be an https:// or git@ clone URL (got "${repo}")`);
  }
  const image = args.image?.trim();
  if (!image) fail("prebuild create needs --image <ref> when non-interactive");
  // Explicit --build wins; otherwise auto-detect, but only when the detected
  // checkout is this same repo (never inherit an unrelated cwd's lockfiles).
  const explicit = (args.build ?? []).map((s) => s.trim()).filter(Boolean);
  const sameRepo =
    args.detect &&
    shortRepo(args.detect.url).toLowerCase() === shortRepo(repo).toLowerCase();
  const build =
    explicit.length > 0
      ? explicit
      : sameRepo && args.detect
        ? detectSetupSteps(args.detect.root)
        : [];
  const spec = buildPrebuildSpec({
    repo,
    branch: args.branch?.trim() || undefined,
    image,
    clonePath: args.clonePath?.trim() || deriveClonePath(repo),
    build,
  });
  return runPrebuild(api, spec, args.force ?? false);
}
