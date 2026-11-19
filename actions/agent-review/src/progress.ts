/**
 * The comment that stands for a review in progress (README.md): posted once the
 * review's sandbox exists, with a link to watch its agents on Atelier, and
 * deleted once the review of issues is posted, which replaces it (the
 * improvements are added to that review after). A review that fails, or
 * stops before it's posted, leaves it saying so. One per PR: each run updates
 * the one an earlier run left.
 */

/** How the comment starts: how a later run finds it among the PR's comments. */
export const PROGRESS_MARKER = "<!-- agent-review-progress -->";

/**
 * The account a workflow's `GITHUB_TOKEN` acts as: the only one whose comment a
 * run updates or deletes, and whose reviews the next one reads back
 * (memory.ts).
 */
export const JOB_ACCOUNT = "github-actions[bot]";

/** A comment on the PR's conversation (not on its diff), as GitHub lists them.
 */
export interface IssueComment {
  id: number;
  body?: string | null;
  user: { login: string } | null;
  created_at?: string;
  /** The author's role in the repository, as GitHub tells: OWNER, MEMBER,
   * COLLABORATOR, CONTRIBUTOR, NONE… */
  author_association?: string;
}

export type Progress =
  /** The agents are on it, in the sandbox at `sandboxUrl` (Atelier's console),
   * for `minutes` at most. */
  | { state: "running"; sandboxUrl: string; minutes: number }
  /** The review threw: nothing posted. */
  | { state: "failed" }
  /** Cancelled (by hand) or out of time before it was posted, with no newer
   * push to review; or cancelled by a push to a PR that is a draft now, which
   * no run reviews until it's ready. */
  | { state: "stopped"; draft?: boolean };

/** The comment for `progress` of the review of `head`. */
export function progressComment(
  progress: Progress,
  head: string,
  runUrl: string,
): string {
  return `${PROGRESS_MARKER}\n${progressText(progress, `\`${head.slice(0, 7)}\``)}\n\n<sub><a href="${runUrl}">Run</a></sub>`;
}

function progressText(progress: Progress, commit: string): string {
  const again =
    "Re-run its job to try again; the next push is reviewed anyway.";
  switch (progress.state) {
    case "running":
      return (
        `🔎 **Agent review of ${commit} in progress**: looking for issues first, then improvements. ` +
        `[Follow the reviewers on Atelier](${progress.sandboxUrl}) (sign in with GitHub). The review of issues ` +
        `replaces this comment once it's posted, and the improvements are added to it after: a few minutes, ` +
        `${progress.minutes} at most.`
      );
    case "failed":
      return `❌ **Agent review of ${commit} failed**: the run's log says why. ${again}`;
    case "stopped":
      return progress.draft
        ? `⏹️ **Agent review of ${commit} stopped**: the PR is a draft now. It's reviewed again once it's ready for review.`
        : `⏹️ **Agent review of ${commit} stopped** (cancelled, or out of time) before it was posted. ${again}`;
  }
}

/** The progress comment among the PR's: the job's own, under the marker. A
 * person's copy of it isn't it. */
export function progressCommentId(
  comments: IssueComment[],
): number | undefined {
  return comments.find(
    (comment) =>
      comment.user?.login === JOB_ACCOUNT &&
      (comment.body ?? "").startsWith(PROGRESS_MARKER),
  )?.id;
}
