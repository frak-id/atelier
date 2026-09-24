import {
  type PrebuildRecord,
  type PrebuildRepo,
  prebuildRepos,
  repoShortName,
} from "@atelier/spec";

export function formatRelativeTime(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diff = now - then;

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return "just now";
}

/** The cloned-repo label for a session's absolute working directory — the
 * trailing path segment (e.g. `/home/dev/wallet` → `wallet`). */
export function repoLabel(directory: string): string {
  const trimmed = directory.replace(/\/+$/, "");
  const base = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return base || directory;
}

/** `owner/name`, plus `#branch` when not the default (see `normalizeBranch`).
 * Same shape as a prebuild job target's branch suffix. */
export function repoBranchLabel(name: string, branch?: string): string {
  return branch ? `${name}#${branch}` : name;
}

/** `1 repo`, `3 repos`: a count with its (regular) plural noun. */
export function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** `, with 2 other repos` when `prebuild` clones repos besides the one the
 * user picked (spawning or rebuilding it brings them along), else "". */
export function otherReposNote(prebuild: PrebuildRecord | undefined): string {
  const others = prebuild ? prebuildRepos(prebuild).length - 1 : 0;
  return others > 0 ? `, with ${countLabel(others, "other repo")}` : "";
}

/** `owner/name#branch` for one repo a prebuild clones. */
export function prebuildRepoLabel(repo: PrebuildRepo): string {
  return repoBranchLabel(repoShortName(repo.url), repo.branch);
}

/** Title for a stored prebuild, from the repos it clones (every one counts,
 * see `prebuildRepos`): one repo reads `owner/name#branch`, several read
 * `a + b` or `a + 2 more`. A prebuild that clones nothing is named by its
 * base image, and a hand-made snapshot (no spec) by its ref. Never from the
 * opaque `metadata`. */
export function prebuildTitle(prebuild: PrebuildRecord): string {
  const labels = prebuildRepos(prebuild).map(prebuildRepoLabel);
  const [first, second] = labels;
  if (first === undefined) {
    const source = prebuild.spec?.source;
    return source && "image" in source ? source.image : prebuild.ref;
  }
  if (labels.length === 1) return first;
  if (labels.length === 2) return `${first} + ${second}`;
  return `${first} + ${labels.length - 1} more`;
}

/** The Rebuild button's tooltip: a multi-repo prebuild re-bakes every repo
 * it clones, not just the one a row is about. */
export function rebuildTitle(prebuild: PrebuildRecord | undefined): string {
  const count = prebuild ? prebuildRepos(prebuild).length : 0;
  return count > 1
    ? `Rebuilds all ${count} repos of this prebuild from their latest commits`
    : "Rebuild from the latest commit";
}
