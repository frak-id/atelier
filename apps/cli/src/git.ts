/** Local git repo detection: are we inside a repo, its remote clone URL +
 * current branch, and the branch list — used to offer "bake a prebuild from
 * this repo" in the cockpit and via `atelier prebuild create`. Every call is
 * best-effort: a missing `git`, a non-repo cwd, or a remoteless repo just
 * yields undefined/empty, never an error. */
import { execFileSync } from "node:child_process";

/** Run `git <args>` in `cwd`, returning trimmed stdout or undefined on any
 * failure (git missing, not a repo, no remote…). Never throws. */
function git(args: string[], cwd: string = process.cwd()): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
  } catch {
    return undefined;
  }
}

export interface GitRepo {
  /** Remote clone URL (origin, or the first configured remote). */
  url: string;
  /** Current branch (HEAD) when on a branch — undefined if detached. */
  branch?: string;
  /** Repo root directory. */
  root: string;
}

/** Origin's URL, falling back to the first configured remote. */
function remoteUrl(cwd: string): string | undefined {
  const origin = git(["remote", "get-url", "origin"], cwd);
  if (origin) return origin;
  const first = git(["remote"], cwd)
    ?.split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  return first ? git(["remote", "get-url", first], cwd) : undefined;
}

/** Detect the git repo containing `cwd`: its root, remote URL, current branch.
 * Returns undefined when not in a repo or the repo has no usable remote (a
 * prebuild needs a clonable URL, so a remoteless repo can't be offered). */
export function detectGitRepo(
  cwd: string = process.cwd(),
): GitRepo | undefined {
  const root = git(["rev-parse", "--show-toplevel"], cwd);
  if (!root) return undefined;
  const url = remoteUrl(cwd);
  if (!url) return undefined;
  const head = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  return { url, branch: head && head !== "HEAD" ? head : undefined, root };
}

/** Local + remote branch names (deduped, `origin/` stripped, no HEAD), for a
 * branch picker. Empty when git can't enumerate them. */
export function listBranches(cwd: string = process.cwd()): string[] {
  const out = git(["branch", "--all", "--format=%(refname:short)"], cwd);
  if (!out) return [];
  const names = out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^origin\//, ""))
    .filter((l) => l && l !== "HEAD");
  return Array.from(new Set(names));
}

/** Trim a clone URL down to `owner/name` for a compact label / comparison
 * (drops scheme, git@ user, and the trailing `.git`). */
export function shortRepo(url: string): string {
  return url
    .replace(/^https?:\/\/[^/]+\//, "")
    .replace(/^git@[^:]+:/, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
}

/** The default clone path for a repo: its bare name (last path segment). */
export function deriveClonePath(url: string): string {
  const name = shortRepo(url).split("/").pop() ?? "repo";
  return name || "repo";
}
