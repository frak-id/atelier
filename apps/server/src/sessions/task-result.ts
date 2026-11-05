/**
 * The git summary captured in the sandbox at the end of a task turn: what a
 * reviewer wants to see before opening the sandbox. One shell command prints
 * `key=value` lines; every probe is allowed to fail (no repo, no upstream,
 * no commits) and is then simply absent.
 */
import type { TaskResult } from "./task.store.ts";

export const GIT_RESULT_COMMAND = [
  "git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0",
  'echo "branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"',
  'echo "head=$(git rev-parse HEAD 2>/dev/null)"',
  `echo "ahead=$(git rev-list --count '@{upstream}..HEAD' 2>/dev/null)"`,
  'echo "diff=$(git diff --shortstat HEAD 2>/dev/null)"',
].join("\n");

/** Parse {@link GIT_RESULT_COMMAND}'s output; `undefined` outside a repo. */
export function parseGitResult(
  stdout: string,
  capturedAt: string,
): TaskResult | undefined {
  const values = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) values.set(line.slice(0, at), line.slice(at + 1).trim());
  }
  const branch = values.get("branch");
  const headSha = values.get("head");
  const ahead = Number.parseInt(values.get("ahead") ?? "", 10);
  const diffStat = values.get("diff");
  if (!branch && !headSha) return undefined;
  return {
    ...(branch && { branch }),
    ...(headSha && { headSha }),
    ...(Number.isFinite(ahead) && { commitsAhead: ahead }),
    ...(diffStat && { diffStat }),
    capturedAt,
  };
}
