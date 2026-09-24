/**
 * Repo-prebuild conventions shared by every client (console, CLI) and the
 * server: how a prebuild is recognized as "the prebuild for repo X", how its
 * job queue row is labelled, and how a quick one-repo prebuild spec is
 * assembled. Pure functions over the spec types, with no Node or DOM APIs,
 * so the browser console, the Node CLI and the Bun server can all import them.
 *
 * These live next to the schemas because they are contract, not UI: two
 * surfaces that disagree on repo identity would each think the other's
 * prebuild is missing, and a job label that drifts from the client's
 * correlation key silently hides the live "building" badge.
 */
import type {
  PrebuildRecord,
  PrebuildRepo,
  PrebuildSpec,
} from "./prebuild-spec.ts";

/**
 * Canonical, case-insensitive identity of a git remote: `host/owner/name`,
 * lowercase, with any scheme, credentials, port, `.git` suffix and trailing
 * slash removed. The https, scp-style (`git@host:owner/name.git`) and
 * `ssh://` spellings of the same repo all map to one key. A string that isn't
 * URL-shaped is trimmed and lowercased as-is (best effort, never throws).
 */
export function repoKey(url: string): string {
  let rest = url.trim();
  // scp-style: git@github.com:owner/name(.git)
  const scp = /^[^/@\s]+@([^:/\s]+):(.+)$/.exec(rest);
  if (scp) {
    rest = `${scp[1]}/${scp[2]}`;
  } else {
    rest = rest
      .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "") // scheme
      .replace(/^[^/@]*@/, "") // credentials
      .replace(/^([^/:]+):\d+(?=\/)/, "$1"); // port
  }
  return rest
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/** `owner/name` for display. Keeps the original casing and drops the host.
 * Falls back to the trimmed input when it isn't URL-shaped. */
export function repoShortName(url: string): string {
  const trimmed = url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  const scp = /^[^/@\s]+@[^:/\s]+:(.+)$/.exec(trimmed);
  if (scp?.[1]) return scp[1];
  const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  if (withoutScheme === trimmed) return trimmed;
  const slash = withoutScheme.indexOf("/");
  return slash === -1 ? withoutScheme : withoutScheme.slice(slash + 1);
}

/** The repo's bare name (last path segment), the default clone path. */
export function repoCloneName(url: string): string {
  const name = repoShortName(url).split(/[/:]/).pop() ?? "";
  return name || "repo";
}

/**
 * The stable identity a prebuild job is queued under (its `target`). It is
 * derived from the repos the prebuild clones, as URL plus `#branch`, so one
 * repo on two branches gives two distinct jobs. A prebuild that clones
 * nothing falls back to its boot source. The server labels jobs with it and
 * clients use it to correlate a running bake back to a row, so both sides
 * MUST call this one function.
 */
export function prebuildJobTarget(spec: PrebuildSpec): string {
  if (spec.repos && spec.repos.length > 0) {
    return spec.repos
      .map((r) => (r.branch ? `${r.url}#${r.branch}` : r.url))
      .join(", ");
  }
  return "image" in spec.source ? spec.source.image : spec.source.snapshot;
}

/** The repo + branch a prebuild targets. The spec's first repo is
 * authoritative; the opaque `metadata.repo`/`metadata.branch` that clients
 * stamp is the fallback. */
export function prebuildRepoBranch(record: PrebuildRecord): {
  url?: string;
  branch?: string;
} {
  const repo: PrebuildRepo | undefined = record.spec?.repos?.[0];
  const url = repo?.url ?? record.metadata?.repo ?? record.metadata?.workspace;
  const branch = repo?.branch ?? record.metadata?.branch;
  return { url, branch: branch?.trim() || undefined };
}

/** Every stored prebuild whose primary repo is `url`, on any branch. Keeps
 * the input order, and `GET /v1/prebuilds` is newest-first, so `[0]` is the
 * most recent bake. */
export function findRepoPrebuilds(
  records: readonly PrebuildRecord[],
  url: string,
): PrebuildRecord[] {
  const want = repoKey(url);
  return records.filter((record) => {
    const rb = prebuildRepoBranch(record);
    return rb.url !== undefined && repoKey(rb.url) === want;
  });
}

/**
 * The canonical spelling of a branch in a prebuild spec: trimmed, and
 * `undefined` for the repo's default branch. "No branch" IS the default
 * branch, so writing specs through this makes a one-click create, a
 * customized create and a first spawn of the same branch produce the SAME
 * spec (same hash, one bake), and makes matching treat `main` and omitted
 * as equal. Without a `defaultBranch` hint only blanks collapse.
 */
export function normalizeBranch(
  branch: string | undefined,
  defaultBranch?: string,
): string | undefined {
  const trimmed = branch?.trim() || undefined;
  return trimmed === defaultBranch?.trim() ? undefined : trimmed;
}

/**
 * The most recent prebuild covering `url` on `branch`. An omitted branch
 * (on either the query or the record) means "the default branch". When the
 * caller knows the repo's `defaultBranch`, an explicit `main` and an omitted
 * branch are treated as equal. Without that hint only exact matches count.
 */
export function findRepoBranchPrebuild(
  records: readonly PrebuildRecord[],
  url: string,
  branch?: string,
  defaultBranch?: string,
): PrebuildRecord | undefined {
  const want = normalizeBranch(branch, defaultBranch);
  return findRepoPrebuilds(records, url).find(
    (record) =>
      normalizeBranch(prebuildRepoBranch(record).branch, defaultBranch) ===
      want,
  );
}

/** Split a prebuild job target (see `prebuildJobTarget`) back into the repos
 * it bakes: `repoKey` identity plus the raw `#branch`, if any. Targets that
 * aren't repo-shaped (an image or snapshot fallback) still parse, and just
 * never match a repo. */
export function parsePrebuildJobTarget(
  target: string | undefined,
): { key: string; branch?: string }[] {
  if (!target) return [];
  return target
    .split(", ")
    .map((part) => {
      const hash = part.indexOf("#");
      const url = (hash === -1 ? part : part.slice(0, hash)).trim();
      const branch = hash === -1 ? undefined : part.slice(hash + 1).trim();
      return { key: url ? repoKey(url) : "", branch: branch || undefined };
    })
    .filter((t) => t.key !== "");
}

/**
 * Best-effort setup-command suggestion from a repo's top-level file names:
 * lockfiles and manifests only, with no network or execution. `has` answers
 * "does this root-level file exist". The CLI backs it with the local
 * checkout and the server backs it with the GitHub contents listing. Returns
 * at most one install step per ecosystem, unscoped (see `inRepoDir`).
 */
export function detectSetupSteps(has: (file: string) => boolean): string[] {
  const steps: string[] = [];

  // Node: pick the package manager from its lockfile, else a plain install.
  if (has("package.json")) {
    if (has("bun.lockb") || has("bun.lock")) steps.push("bun install");
    else if (has("pnpm-lock.yaml"))
      steps.push("pnpm install --frozen-lockfile");
    else if (has("yarn.lock")) steps.push("yarn install --frozen-lockfile");
    else if (has("package-lock.json")) steps.push("npm ci");
    else steps.push("npm install");
  }

  // Python: one of poetry / pipenv / pip, in that precedence.
  if (has("poetry.lock")) steps.push("poetry install");
  else if (has("Pipfile")) steps.push("pipenv install --deploy");
  else if (has("requirements.txt"))
    steps.push("pip install -r requirements.txt");
  else if (has("pyproject.toml")) steps.push("pip install .");

  if (has("Cargo.toml")) steps.push("cargo fetch");
  if (has("go.mod")) steps.push("go mod download");
  if (has("Gemfile")) steps.push("bundle install");
  if (has("composer.json")) steps.push("composer install");

  return steps;
}

/** Build steps run as `dev` from the home dir, each in a fresh shell, so a
 * bare `npm ci` would miss the repo. Prefix the step with
 * `cd <clonePath> &&` unless it already starts with a `cd`. */
function inRepoDir(step: string, clonePath: string): string {
  return /^\s*cd\s/.test(step) ? step : `cd ${clonePath} && ${step}`;
}

interface RepoPrebuildInput {
  /** Clone URL (https or scp-style). */
  repo: string;
  /** Omit for the repo's default branch. */
  branch?: string;
  /** Base image the prebuild boots from. */
  image: string;
  /** Defaults to the repo's bare name. */
  clonePath?: string;
  /** Raw setup commands; each is scoped to `clonePath` (see `inRepoDir`). */
  build?: string[];
}

/** Assemble a single-repo PrebuildSpec: boot from `image`, clone
 * `repo@branch` into `clonePath`, run the repo-scoped build steps, and
 * stamp `repo`/`branch` metadata so listings can recognize it later. */
export function buildRepoPrebuildSpec(input: RepoPrebuildInput): PrebuildSpec {
  const repo = input.repo.trim();
  const branch = input.branch?.trim() || undefined;
  const clonePath = input.clonePath?.trim() || repoCloneName(repo);
  const metadata: Record<string, string> = { repo };
  if (branch) metadata.branch = branch;
  const build = (input.build ?? [])
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => inRepoDir(s, clonePath));
  return {
    source: { image: input.image },
    repos: [{ url: repo, ...(branch ? { branch } : {}), clonePath }],
    ...(build.length > 0 ? { build } : {}),
    metadata,
  };
}
