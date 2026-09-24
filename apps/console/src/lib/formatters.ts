import {
  type PrebuildRecord,
  prebuildRepoBranch,
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

/** Title for a stored prebuild: `owner/name` (+ `#branch`) for repo
 * prebuilds, falling back to the snapshot ref for image-only ones. */
export function prebuildTitle(prebuild: PrebuildRecord): string {
  const { url, branch } = prebuildRepoBranch(prebuild);
  return url ? repoBranchLabel(repoShortName(url), branch) : prebuild.ref;
}
