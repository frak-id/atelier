/**
 * The agent review of a pull request (README.md), run by the action
 * (action.yml):
 *
 * 1. a sandbox on Atelier, as the service account whose key the job holds, from
 *    the repository's prebuild, at the PR's head;
 * 2. the PR's diff written to files there (diff-files.sh), since the agent's
 *    sub-agents can't run git;
 * 3. two tasks for its coding agent (pi), one after the other: one reviews the
 *    PR's diff (merge base to head) for issues (prompt.ts), the other for
 *    improvements (improvements.ts), each with its own sub-agents, and each
 *    writes its findings to a file. After an earlier agent review, each gets
 *    that review's open findings of its kind, the replies to them and what
 *    changed since (memory.ts). How many minor findings and improvements a
 *    review reports grows with the diff (limits.ts);
 * 4. the files read back, checked, merged, and posted as one review on the PR
 *    with the job's token (github-review.ts), with what the next review starts
 *    from hidden in it; the earlier reviews are collapsed. Without the
 *    improvements (their agent failed), the issues are posted all the same;
 * 5. the sandbox destroyed, whatever happened.
 *
 * From the sandbox's creation to the review's posting, a comment on the PR
 * links to the sandbox on Atelier, where the agent can be watched
 * (progress.ts). The review replaces it; a failed review leaves it saying so.
 *
 * The mode is the first argument, else `MODE`, else `cleanup` when the PR was
 * just closed and `review` otherwise. `cleanup` only destroys the PR's review
 * sandboxes and deletes the progress comment (the PR closed), and
 * `cleanup-head` destroys those of the run's head commit (the run cancelled: a
 * newer push's run may have one already). `dry-run` reviews but prints the
 * review instead of posting it (any token that reads the PR), and leaves the
 * PR's comments alone.
 *
 * The sandbox's GitHub token should be read only (README.md, *Setup*): the
 * agent can fetch, not push or comment. What it writes is untrusted (a PR can
 * try to steer it): the job only posts it, as a comment.
 */
import { Atelier } from "../../shared/src/atelier.ts";
import { gitHub } from "../../shared/src/github.ts";
import {
  isRepositoryPath,
  repositoryInstructions,
} from "../../shared/src/instructions.ts";
import { job, sleep } from "../../shared/src/job.ts";
import {
  type Deadline,
  deadlineIn,
  HOME,
  SANDBOX_NAME_MAX,
  sandboxes,
} from "../../shared/src/sandbox.ts";
import {
  buildReview,
  commentableLines,
  type Lane,
  type PostedComment,
  type PostedReview,
  parseReviewFile,
  postedByRun,
  type ReviewFile,
  type ReviewToPost,
  runLink,
  supersede,
  withoutComments,
} from "./github-review.ts";
import { improvementsPrompt } from "./improvements.ts";
import {
  findingLimits,
  improvementCategories,
  LIMITED,
  type Limits,
  parseAllowedFindings,
} from "./limits.ts";
import {
  conversationSince,
  decodeState,
  earlierReview,
  encodeState,
  type ReviewState,
  resolve,
  type StoredFinding,
  threadReplies,
} from "./memory.ts";
import {
  type IssueComment,
  JOB_ACCOUNT,
  type Progress,
  progressComment,
  progressCommentId,
} from "./progress.ts";
import {
  type ChangedFile,
  changedLines,
  type EarlierReview,
  listedFiles,
  reviewPrompt,
  SUBAGENT_SETTINGS,
  type SubagentSetting,
  withSubagents,
} from "./prompt.ts";

const { log, warn, notice, fail, env, minutes } = job(
  "agent-review",
  "Agent review",
);

// Dependabot's runs get no secret, like a fork's PR: its PRs aren't reviewed,
// and that's no failure. Any other run without the key is misconfigured.
if (
  !process.env.ATELIER_API_KEY &&
  process.env.GITHUB_ACTOR === "dependabot[bot]"
) {
  notice("Dependabot's runs get no secret: its pull requests aren't reviewed.");
  process.exit(0);
}

const ATELIER = env("ATELIER_URL").replace(/\/+$/, "");
const ATELIER_MCP = `${ATELIER}/mcp`;
/** The base image the sandbox boots on: the repository's prebuild on it is
 * reused. */
const IMAGE = process.env.IMAGE || "dev-base";
const REVIEW_FILE = `${HOME}/agent-review.json`;
const IMPROVEMENTS_FILE = `${HOME}/agent-review-improvements.json`;
/** Where diff-files.sh writes the diff: outside the clone, so it's no change to
 * review. */
const DIFF_DIR = `${HOME}/agent-review-diff`;
/**
 * The issues' agent's share of the agents' time, when the improvements' one
 * follows: that one gets what's left. They run one after the other, not at
 * once: pi-acp (0.0.33 and 0.0.34) keeps one live session. A new one closes
 * the others (`closeAllExcept` in its `newSession`), which kills their pi
 * process: a turn in flight is aborted, its sub-agents stopped, and its ACP
 * prompt never answered (the task stays running), or pi-acp crashes on its
 * next write to it (EPIPE), failing every task.
 */
const ISSUES_SHARE = 0.7;
/** Below this, no time for the improvements: they're not reviewed. */
const MIN_IMPROVEMENTS_MINUTES = 3;
/** The agent's turns, past which the task is cancelled: the job's own timeout
 * is above this and the sandbox's boot. */
const TASK_MINUTES = minutes("AGENT_TIMEOUT_MINUTES", 40);

/** The workflow's `subagents`: `auto` decides by the diff's size (prompt.ts). */
const SUBAGENTS = (process.env.SUBAGENTS || "auto") as SubagentSetting;
if (!SUBAGENT_SETTINGS.includes(SUBAGENTS))
  fail(`subagents must be ${SUBAGENT_SETTINGS.join(", ")}, not "${SUBAGENTS}"`);
/** A model id or toolbox selector: it goes into the prompt and Atelier's
 * calls, so nothing but what one is made of. */
const ID = /^[\w.:@/+-]+$/;
/** The model the sub-agents run on (pi-subagents' `model`), if the workflow
 * picks one; the agent's own comes from its toolbox. */
const REVIEWER_MODEL = process.env.REVIEWER_MODEL?.trim() || undefined;
if (REVIEWER_MODEL !== undefined && !ID.test(REVIEWER_MODEL))
  fail(`reviewer-model is no model id: "${REVIEWER_MODEL}"`);
/** How many minor findings and improvements a review reports (limits.ts). */
const ALLOWED: Limits = (() => {
  try {
    return parseAllowedFindings(process.env.ALLOWED_FINDINGS ?? "");
  } catch (error) {
    return fail((error as Error).message);
  }
})();
/** The categories of improvement looked for. None: no agent looks for any. */
const CATEGORIES = improvementCategories(ALLOWED);
/** Toolboxes the sandbox gets on top of the org's auto-included ones (`whoami`
 * selectors), comma- or line-separated. */
const TOOLBOXES = (process.env.TOOLBOXES ?? "").split(/[\s,]+/).filter(Boolean);
for (const selector of TOOLBOXES)
  if (!ID.test(selector)) fail(`toolboxes: no toolbox selector: "${selector}"`);
/** What the repository adds to the prompt, from its workflow and from a file
 * read at the PR's base, so a PR can't rewrite the rules it's reviewed by. */
const INSTRUCTIONS = process.env.INSTRUCTIONS?.trim() ?? "";
const INSTRUCTIONS_FILE = (process.env.INSTRUCTIONS_FILE ?? "REVIEW.md").trim();
if (!isRepositoryPath(INSTRUCTIONS_FILE))
  fail(
    `instructions-file must be a path from the repository's root: "${INSTRUCTIONS_FILE}"`,
  );

const repository = env("GITHUB_REPOSITORY"); // owner/name
const repositoryName = repository.split("/")[1] ?? repository;
const number = Number(
  env(
    "PR_NUMBER",
    "PR_NUMBER is not set: the action runs on pull_request events",
  ),
);
const atelier = new Atelier(
  ATELIER_MCP,
  env(
    "ATELIER_API_KEY",
    "ATELIER_API_KEY is empty: the `api-key` secret isn't set, or doesn't reach this workflow " +
      "(on GitHub's free plan, an organization secret doesn't reach a private repository)",
  ),
  { name: "agent-review", log },
);
const {
  request: github,
  all: githubAll,
  graphql,
} = gitHub({ repository, token: env("GITHUB_TOKEN"), log });
/**
 * Every PR's review sandbox carries the PR in its metadata (`marker`), so the
 * PR's next run, or its close, destroys any a dead job left
 * (`destroyReviewSandboxes`).
 */
const {
  destroyAll: destroyReviewSandboxes,
  destroy: destroySandbox,
  waitUntilRunning: waitForSandbox,
  exec,
  runTurn,
} = sandboxes(
  atelier,
  { log, warn },
  "the PR's next run, or its close, destroys it",
);
// A closed PR's run only cleans up after its reviews.
const mode =
  process.argv[2] ||
  process.env.MODE ||
  (process.env.EVENT_ACTION === "closed" ? "cleanup" : "review");
if (!["review", "dry-run", "cleanup", "cleanup-head"].includes(mode))
  fail(`unknown mode: ${mode}`);
/**
 * Every sandbox of this PR's reviews carries it: how a later run finds the ones
 * a dead job left. The repository's owner is in it, since one account may
 * review several owners' repositories. A dry run's are apart, so a dry run and
 * the CI never destroy each other's.
 */
const marker = {
  "agent-review": `${repository}#${number}${mode === "dry-run" ? "-dry-run" : ""}`,
};
const headMarker = (head: string) => ({ ...marker, "agent-review-head": head });
/**
 * Where the review step leaves its sandbox's id, for the `cleanup-head` step of
 * a cancelled job (same job, same runner): a sandbox whose create job hasn't
 * landed its record isn't in Atelier's list yet. Not in a dry run.
 */
const sandboxIdFile =
  process.env.RUNNER_TEMP && mode !== "dry-run"
    ? `${process.env.RUNNER_TEMP}/agent-review-sandbox`
    : undefined;

/**
 * The name of the review sandbox of `head`. Atelier takes it as the create's
 * idempotency key (a retry gets the sandbox it made), so a dry run's differs:
 * it would get the CI's sandbox otherwise, and destroy it. The repository's
 * name is cut to fit.
 */
function sandboxName(head: string): string {
  const prefix = "review-";
  const suffix = `-${number}-${head.slice(0, 7)}${mode === "dry-run" ? "-dry" : ""}`;
  const room = SANDBOX_NAME_MAX - prefix.length - suffix.length;
  return `${prefix}${repositoryName.slice(0, room)}${suffix}`;
}

const runUrl = runLink(
  `${process.env.GITHUB_SERVER_URL}`,
  repository,
  `${process.env.GITHUB_RUN_ID}`,
  process.env.GITHUB_RUN_ATTEMPT ?? "1",
);

const COLLAPSE = `mutation($id: ID!) {
    minimizeComment(input: { subjectId: $id, classifier: OUTDATED }) { minimizedComment { isMinimized } }
}`;

async function createSandbox(headRef: string, head: string): Promise<string> {
  const created = await atelier.call<{ id: string }>("create_sandbox", {
    name: sandboxName(head),
    spec: { source: { image: IMAGE }, metadata: headMarker(head) },
    ...(TOOLBOXES.length > 0 ? { toolboxes: TOOLBOXES } : {}),
    // The repository's prebuild, switched to the PR's branch (its build steps
    // re-run in the background).
    repo: { url: `https://github.com/${repository}.git`, branch: headRef },
  });
  log(`sandbox ${created.id} booting`);
  if (sandboxIdFile)
    await Bun.write(sandboxIdFile, created.id).catch((error) =>
      log(`sandbox id not left for a cancelled job's cleanup: ${error}`),
    );
  return created.id;
}

/** The file at `path` in sandbox `id`, 1 MB at most. */
async function readFile(id: string, path: string): Promise<string> {
  const { files } = await atelier.call<{
    files: { content?: string; error?: string; truncated?: boolean }[];
  }>("read_files", { id, paths: [path], maxBytes: 1_000_000 });
  const [file] = files;
  if (!file || file.content === undefined)
    throw new Error(`${path}: ${file?.error ?? "missing"}`);
  if (file.truncated) throw new Error(`${path} is over 1 MB`);
  return file.content;
}

/** The review file an agent of `lane` wrote at `path`, checked. */
async function readReviewFile(
  id: string,
  path: string,
  earlier: ReadonlySet<string>,
  lane: Lane,
): Promise<ReviewFile> {
  return parseReviewFile(
    await readFile(id, path),
    `${HOME}/${repositoryName}`,
    earlier,
    lane,
  );
}

/** The files diff-files.sh listed in `name` (files.tsv, delta-files.tsv), with
 * their counts. */
async function readListedFiles(
  id: string,
  name: string,
): Promise<ChangedFile[]> {
  return listedFiles(await readFile(id, `${DIFF_DIR}/${name}`));
}

/**
 * One agent's review, in its own task in the sandbox: its file, read back and
 * checked, and asked for again once, in the same context, if it can't be used.
 */
async function reviewTask(
  target: { sandboxId: string; cwd: string },
  lane: Lane,
  prompt: string,
  output: string,
  earlier: ReadonlySet<string>,
  deadline: Deadline,
): Promise<ReviewFile> {
  const label = `${lane} agent`;
  const task = await runTurn(target, prompt, deadline, label);
  try {
    try {
      return await readReviewFile(target.sandboxId, output, earlier, lane);
    } catch (error) {
      log(
        `${output} unusable (${(error as Error).message}): asking the ${label} again`,
      );
      await runTurn(
        { taskId: task.taskId },
        `${output} can't be used: ${(error as Error).message}. Write it again as the schema says, ` +
          `check it with \`jq . ${output}\`, then reply with the number of findings per ` +
          `${lane === "issues" ? "severity" : "category"}.`,
        deadline,
        label,
      );
      return await readReviewFile(target.sandboxId, output, earlier, lane);
    }
  } finally {
    await atelier
      .call("manage_task", { taskId: task.taskId, action: "close" })
      .catch(() => {});
  }
}

/**
 * The PR's earlier agent review, as the prompt gets it (without `delta`, known
 * once its head is fetched), and its state, for merging the new review with it.
 */
async function findEarlierReview(
  author: string,
): Promise<
  { state: ReviewState; prompt: Omit<EarlierReview, "delta"> } | undefined
> {
  const earlier = earlierReview(
    await githubAll<PostedReview>(`/pulls/${number}/reviews`),
    JOB_ACCOUNT,
  );
  if (!earlier) return undefined;
  const replies = threadReplies(
    await githubAll<PostedComment>(`/pulls/${number}/comments`),
    JOB_ACCOUNT,
    author,
  );
  const conversation = conversationSince(
    await githubAll<IssueComment>(`/issues/${number}/comments`),
    earlier.submittedAt,
    earlier.state.open.map((finding) => finding.id),
    JOB_ACCOUNT,
    author,
  );
  const { state } = earlier;
  log(
    `earlier review of ${state.head}: ${state.open.length} open findings, ${state.dismissed.length} dismissed`,
  );
  return {
    state,
    prompt: {
      head: state.head,
      open: state.open.map((finding) => ({
        ...finding,
        replies: replies.get(finding.id) ?? [],
      })),
      dismissed: state.dismissed,
      conversation,
    },
  };
}

/** Writes the PR's diff, and what changed since `since`, to DIFF_DIR in the
 * sandbox: what diff-files.sh printed. */
async function writeDiffFiles(
  id: string,
  cwd: string,
  mergeBase: string,
  head: string,
  since?: string,
) {
  const script = Buffer.from(
    await Bun.file(new URL("diff-files.sh", import.meta.url)).text(),
  ).toString("base64");
  const path = `${DIFF_DIR}.sh`;
  return exec(
    id,
    `echo '${script}' | base64 -d > ${path} && bash ${path} ${mergeBase} ${head} ${DIFF_DIR}${since ? ` ${since}` : ""}`,
    cwd,
  );
}

interface PullRequest {
  title: string;
  body: string | null;
  state: "open" | "closed";
  draft?: boolean;
  user: { login: string } | null;
  head: { ref: string; sha: string; repo: { full_name: string } | null };
  base: { sha: string };
}

/** The progress comment, if the PR has one. */
async function findProgressComment(): Promise<number | undefined> {
  return progressCommentId(
    await githubAll<IssueComment>(`/issues/${number}/comments`),
  );
}

/**
 * Posts the progress comment, or updates the one there. Not in a dry run. A
 * failure only warns: the review matters more than its progress.
 */
async function showProgress(progress: Progress, head: string): Promise<void> {
  if (mode === "dry-run") return;
  try {
    const body = JSON.stringify({
      body: progressComment(progress, head, runUrl),
    });
    const id = await findProgressComment();
    if (id) await github(`/issues/comments/${id}`, { method: "PATCH", body });
    else await github(`/issues/${number}/comments`, { method: "POST", body });
    log(`progress comment ${id ? "updated" : "posted"}: ${progress.state}`);
  } catch (error) {
    warn(`progress comment not updated (${progress.state}): ${error}`);
  }
}

/** Deletes the progress comment: the review replaced it, or the PR closed. Not
 * in a dry run. */
async function removeProgress(): Promise<void> {
  if (mode === "dry-run") return;
  try {
    const id = await findProgressComment();
    if (id === undefined) return;
    // Gone already (another run deleted it): fine.
    await github(`/issues/comments/${id}`, { method: "DELETE" }).catch(
      (error) => {
        if ((error as { status?: number }).status !== 404) throw error;
      },
    );
    log("progress comment deleted");
  } catch (error) {
    warn(`progress comment left in view: ${error}`);
  }
}

interface Comparison {
  merge_base_commit: { sha: string };
  total_commits: number;
  commits: { sha: string; commit: { message: string } }[];
}

async function review(): Promise<void> {
  const pr = await github<PullRequest>(`/pulls/${number}`);
  // A fork's branch isn't one of this repository's, for the sandbox to boot on,
  // and the sandbox would run its code with the secrets of the account's org.
  if (pr.head.repo?.full_name !== repository) {
    notice(
      `#${number} comes from ${pr.head.repo?.full_name ?? "a deleted fork"}: not reviewed`,
    );
    return;
  }
  // The event's commits: a newer push starts another run, which cancels this
  // one. A dry run takes the PR's.
  const base = process.env.BASE_SHA || pr.base.sha;
  const head = process.env.HEAD_SHA || pr.head.sha;
  try {
    await reviewRange(pr, base, head);
  } catch (error) {
    await showProgress({ state: "failed" }, head);
    throw error;
  }
  // Posted: it replaces the progress comment.
  await removeProgress();
}

async function reviewRange(
  pr: PullRequest,
  base: string,
  head: string,
): Promise<void> {
  // What the PR brings is from the merge base: the sandbox's clone is shallow,
  // so git can't find it there.
  const comparison = await github<Comparison>(`/compare/${base}...${head}`);
  const mergeBase = comparison.merge_base_commit.sha;
  // Commits go into shell commands: only what a commit's sha can be.
  for (const sha of [mergeBase, head])
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`not a commit: ${sha}`);
  const earlier = await findEarlierReview(pr.user?.login ?? "");
  const instructions = await repositoryInstructions(
    { request: github },
    { log, warn },
    {
      inline: INSTRUCTIONS,
      file: INSTRUCTIONS_FILE,
      ref: base,
      fileSource: "on the target branch",
    },
  );
  await destroyReviewSandboxes(marker);

  const sandboxId = await createSandbox(pr.head.ref, head).catch(
    async (error) => {
      // The call may have failed after Atelier created it: it has this head's
      // marker.
      await destroyReviewSandboxes(headMarker(head)).catch(() => {});
      throw error;
    },
  );
  try {
    // Its console page shows the agent's session live, to the people of the
    // account's org.
    await showProgress(
      {
        state: "running",
        sandboxUrl: `${ATELIER}/sandboxes/${sandboxId}/sessions`,
        minutes: TASK_MINUTES,
      },
      head,
    );
    await waitForSandbox(sandboxId);
    const cwd = `${HOME}/${repositoryName}`;
    // Both ends, whatever the branches did since: the review is of exactly this
    // range. Forced: the prebuild's install leaves its own changes in the clone
    // (bun.lock). Only the commits, not their history: the clone is shallow,
    // and fetching a commit into it brings its whole history otherwise, too
    // slow on a big repository. diff-files.sh only compares trees.
    await exec(
      sandboxId,
      `git fetch --quiet --no-tags --depth 1 origin ${mergeBase} ${head} && git checkout --quiet --force --detach ${head}`,
      cwd,
    );
    log(`checked out ${head} in ${cwd}`);
    // The earlier review's head, for what changed since: gone if the branch was
    // force-pushed and GitHub dropped it.
    let since: string | undefined;
    if (earlier && earlier.state.head !== head) {
      since = await exec(
        sandboxId,
        `git fetch --quiet --no-tags --depth 1 origin ${earlier.state.head}`,
        cwd,
      ).then(
        () => earlier.state.head,
        (error) => {
          log(
            `earlier head ${earlier.state.head} not fetched, no delta: ${(error as Error).message}`,
          );
          return undefined;
        },
      );
    }
    const delta: EarlierReview["delta"] =
      since !== undefined
        ? "written"
        : earlier?.state.head === head
          ? "unchanged"
          : "unavailable";
    const diffSummary = await writeDiffFiles(
      sandboxId,
      cwd,
      mergeBase,
      head,
      since,
    );
    log(`diff files in ${DIFF_DIR}: ${diffSummary}`);

    // The diff's size, from what diff-files.sh listed (GitHub's compare stops at
    // 300 files), and what changed since the earlier review.
    const files = await readListedFiles(sandboxId, "files.tsv");
    const deltaFiles =
      since !== undefined
        ? await readListedFiles(sandboxId, "delta-files.tsv")
        : [];
    const lines = changedLines(files);
    // Improvements are looked for in what changed since the earlier review when
    // it looked for them (memory.ts) and that can be told; else in the whole PR.
    const improvementsSince =
      earlier?.state.improvements && delta !== "unavailable"
        ? changedLines(deltaFiles)
        : undefined;
    const scope =
      improvementsSince === undefined
        ? "diff"
        : improvementsSince > 0
          ? "delta"
          : "none";
    const reviewed =
      scope === "diff" ? files : scope === "delta" ? deltaFiles : [];
    const limits = findingLimits(ALLOWED, {
      lines,
      later: earlier !== undefined,
      ...(improvementsSince !== undefined ? { improvementsSince } : {}),
    });
    const subagents = withSubagents(SUBAGENTS, files);
    const improvementSubagents = withSubagents(SUBAGENTS, reviewed);
    // Each agent rules on its own kind of earlier findings. Those of a category
    // the workflow no longer asks for are dismissed (`turnedOff`).
    const earlierOf = (
      keep: (finding: StoredFinding) => boolean,
    ): EarlierReview | undefined =>
      earlier && {
        ...earlier.prompt,
        delta,
        open: earlier.prompt.open.filter(keep),
      };
    const issuesEarlier = earlierOf((finding) => !finding.category);
    const improvementsEarlier = earlierOf(
      (finding) =>
        finding.category !== undefined && CATEGORIES.includes(finding.category),
    );
    const turnedOff = (earlier?.state.open ?? []).flatMap((finding) =>
      finding.category && !CATEGORIES.includes(finding.category)
        ? [
            {
              id: finding.id,
              status: "dismissed" as const,
              note: `The workflow no longer asks for ${finding.category} improvements.`,
            },
          ]
        : [],
    );
    // With nothing new to look at and no earlier improvement to rule on,
    // there's nothing for it to do.
    const withImprovements =
      CATEGORIES.length > 0 &&
      (scope !== "none" || (improvementsEarlier?.open.length ?? 0) > 0);
    log(
      `${lines} changed lines in ${files.length} files, lockfiles aside${since !== undefined ? `, ${changedLines(deltaFiles)} since the earlier review` : ""}; ` +
        `issues: ${subagents ? "with sub-agents" : "the agent alone"}, at most ${limits.minor} new minor; ` +
        (withImprovements
          ? `improvements in ${scope === "diff" ? "the whole PR" : scope === "delta" ? "what changed since" : "nothing new"}: ` +
            `${improvementSubagents ? "with sub-agents" : "the agent alone"}, at most ${CATEGORIES.map((category) => `${limits[category]} ${category}`).join(", ")}`
          : "no improvements"),
    );
    if (
      !subagents &&
      !(withImprovements && improvementSubagents) &&
      REVIEWER_MODEL
    )
      log(`reviewer-model ${REVIEWER_MODEL} unused: no sub-agents`);

    const model = REVIEWER_MODEL ? { model: REVIEWER_MODEL } : {};
    const pull = {
      repository,
      number,
      title: pr.title,
      description: pr.body ?? "",
      mergeBase,
      head,
      commits: comparison.commits.map(
        (c) => `${c.sha.slice(0, 7)} ${c.commit.message.split("\n")[0]}`,
      ),
      totalCommits: comparison.total_commits,
      cwd,
      minutes: TASK_MINUTES,
      diffDir: DIFF_DIR,
      diffSummary,
      instructions,
    };
    const ids = (review: EarlierReview | undefined) =>
      new Set(review?.open.map((finding) => finding.id));
    const deadline = deadlineIn(TASK_MINUTES);
    const target = { sandboxId, cwd };
    // One agent after the other, each in its own task (ISSUES_SHARE): the
    // issues' first, the improvements' with what's left, told what the issues'
    // reported. Its failure doesn't take the issues' review with it.
    const issuesMinutes = withImprovements
      ? Math.max(1, Math.round(TASK_MINUTES * ISSUES_SHARE))
      : TASK_MINUTES;
    const issues = await reviewTask(
      target,
      "issues",
      reviewPrompt({
        ...pull,
        minutes: issuesMinutes,
        ...(issuesEarlier ? { earlier: issuesEarlier } : {}),
        subagents: subagents ? model : false,
        maxMinors: limits.minor,
        improvements: CATEGORIES,
        output: REVIEW_FILE,
      }),
      REVIEW_FILE,
      ids(issuesEarlier),
      deadlineIn(issuesMinutes),
    );
    const minutesLeft = Math.floor((deadline.at - Date.now()) / 60_000);
    const improvements = !withImprovements
      ? undefined
      : minutesLeft < MIN_IMPROVEMENTS_MINUTES
        ? { failed: `${minutesLeft} minutes left after the issues' review` }
        : await reviewTask(
            target,
            "improvements",
            improvementsPrompt({
              ...pull,
              minutes: minutesLeft,
              ...(improvementsEarlier ? { earlier: improvementsEarlier } : {}),
              subagents: improvementSubagents ? model : false,
              categories: CATEGORIES,
              scope,
              limits,
              issues: issues.findings,
              output: IMPROVEMENTS_FILE,
            }),
            IMPROVEMENTS_FILE,
            ids(improvementsEarlier),
            deadline,
          ).then(
            (file) => ({ file }),
            (error: Error) => ({ failed: error.message }),
          );
    // The whole files, each in one line: the run's log keeps every review,
    // whatever happens to the comments.
    console.log(`[agent-review] review file: ${JSON.stringify(issues)}`);
    if (improvements && "file" in improvements)
      console.log(
        `[agent-review] improvements file: ${JSON.stringify(improvements.file)}`,
      );
    else if (improvements)
      warn(`improvements not reviewed: ${improvements.failed}`);
    const other =
      improvements && "file" in improvements ? improvements.file : undefined;
    const result: ReviewFile = {
      summary: issues.summary,
      findings: [...issues.findings, ...(other ? other.findings : [])],
      previous: [
        ...issues.previous,
        ...(other ? other.previous : []),
        ...turnedOff,
      ],
    };
    // Whether improvements were looked for up to this head: by its agent now,
    // or by an earlier one, with nothing that counts changed since.
    const improvementsCovered = withImprovements
      ? other !== undefined
      : CATEGORIES.length > 0 && scope === "none";

    const {
      findings,
      dropped,
      since: changes,
      state,
    } = resolve(result, earlier?.state, head, limits, improvementsCovered);
    // Past what this review may report (limits.ts): in the log's review files
    // above, not on the PR.
    const past = LIMITED.filter((kind) => dropped[kind] > 0);
    if (past.length > 0)
      log(
        `dropped, past what this review reports: ${past.map((kind) => `${dropped[kind]} ${kind}`).join(", ")}`,
      );
    const encoded = encodeState(state);
    // Too big, the state keeps no open finding (memory.ts): the next review
    // starts from it all the same, not from an older review's.
    const kept = decodeState(encoded);
    if ((kept?.open.length ?? 0) < state.open.length) {
      warn(
        `the review's state is too big to keep whole: the next review gets none of its ${state.open.length} ` +
          `open findings, and only the last ${kept?.dismissed.length ?? 0} of its ${state.dismissed.length} dismissed ones`,
      );
    }
    await postReview(
      {
        summary: result.summary,
        findings,
        ...(changes ? { since: changes } : {}),
        state: encoded,
        ...(improvements
          ? {
              improvements:
                "file" in improvements
                  ? { summary: improvements.file.summary }
                  : { failed: improvements.failed },
            }
          : {}),
      },
      base,
      head,
    );
  } finally {
    await destroySandbox(sandboxId);
  }
}

async function postReview(
  result: ReviewToPost,
  base: string,
  head: string,
): Promise<void> {
  const files = await githubAll<{ filename: string; patch?: string }>(
    `/pulls/${number}/files`,
  );
  const footer =
    `Reviewed ${base.slice(0, 7)}...${head.slice(0, 7)} by a coding agent on Atelier: check a finding before ` +
    `acting on it. <a href="${runUrl}">Run</a>`;
  const post = (payload: { body: string; comments: unknown[] }) =>
    postOnce(payload, head);
  const payload = buildReview(result, commentableLines(files), footer);
  if (mode === "dry-run") {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  let posted: PostedReview;
  try {
    posted = await post(payload);
    log(
      `posted: ${result.findings.length} findings, ${payload.comments.length} on the diff's lines`,
    );
  } catch (error) {
    // GitHub refuses the whole review (422) for one comment it won't place:
    // everything in the body instead.
    if ((error as { status?: number }).status !== 422) throw error;
    log(
      `review with comments refused (${(error as Error).message}): posting it without them`,
    );
    posted = await post(withoutComments(result, footer));
    log(`posted: ${result.findings.length} findings, all in the review's body`);
  }
  // The new review is up: a failure here leaves the earlier ones in view, a
  // warning rather than a red check.
  await supersedeEarlierReviews(posted).catch((error) =>
    warn(`earlier reviews left in view: ${error}`),
  );
}

/**
 * Posts the review, once. A 5xx or a lost connection doesn't say whether GitHub
 * made it (a big review can time out after it's made, answering 502): this
 * run's review is looked for, and posted again only if it isn't there.
 */
async function postOnce(
  payload: { body: string; comments: unknown[] },
  head: string,
): Promise<PostedReview> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await github<PostedReview>(`/pulls/${number}/reviews`, {
        method: "POST",
        body: JSON.stringify({ commit_id: head, event: "COMMENT", ...payload }),
      });
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status !== undefined && status < 500) throw error;
      await sleep(15_000);
      const reviews = await githubAll<PostedReview>(`/pulls/${number}/reviews`);
      const made = postedByRun(reviews, JOB_ACCOUNT, head, runUrl);
      if (made) {
        log(
          `GitHub answered ${(error as Error).message.split("\n")[0]}, but the review is there`,
        );
        return made;
      }
      if (attempt === 2) throw error;
      log(
        `review not posted (${(error as Error).message.split("\n")[0]}): posting it again`,
      );
    }
  }
}

/**
 * The run was cancelled before posting its review. With a newer push, that
 * push's run takes the progress comment over, unless the PR is a draft now: the
 * workflow skips drafts (README.md), so no run does until it's ready for
 * review, and the comment says it stopped. With the PR closed, the cleanup job
 * deletes it; otherwise (cancelled by hand, or out of time), it says it
 * stopped.
 */
async function stopped(head: string): Promise<void> {
  const pr = await github<PullRequest>(`/pulls/${number}`);
  if (pr.state !== "open") return;
  if (pr.draft) await showProgress({ state: "stopped", draft: true }, head);
  else if (pr.head.sha === head) await showProgress({ state: "stopped" }, head);
}

/** Leaves only `latest` in view (`supersede`): the job's token can collapse its
 * own reviews and comments. */
async function supersedeEarlierReviews(latest: PostedReview): Promise<void> {
  const collapse = supersede(
    latest,
    await githubAll<PostedReview>(`/pulls/${number}/reviews`),
    await githubAll<PostedComment>(`/pulls/${number}/comments`),
  );
  // What a previous run collapsed stays so: only the rest.
  const open: string[] = [];
  for (let i = 0; i < collapse.length; i += 100) {
    const { nodes } = await graphql<{
      nodes: ({ id: string; isMinimized?: boolean } | null)[];
    }>(
      "query($ids: [ID!]!) { nodes(ids: $ids) { id ... on Minimizable { isMinimized } } }",
      { ids: collapse.slice(i, i + 100) },
    );
    open.push(
      ...nodes.flatMap((node) =>
        node && node.isMinimized === false ? [node.id] : [],
      ),
    );
  }
  for (const id of open) {
    await graphql(COLLAPSE, { id });
  }
  log(`earlier reviews: ${open.length} reviews or comments collapsed`);
}

try {
  if (mode === "cleanup") {
    await destroyReviewSandboxes(marker);
    await removeProgress();
  } else if (mode === "cleanup-head") {
    // The review step's sandbox, which Atelier may not list yet.
    const left = sandboxIdFile
      ? (
          await Bun.file(sandboxIdFile)
            .text()
            .catch(() => "")
        ).trim()
      : "";
    await destroyReviewSandboxes(
      headMarker(env("HEAD_SHA")),
      left ? [left] : [],
    );
    await stopped(env("HEAD_SHA"));
  } else await review();
} catch (error) {
  fail((error as Error).message);
}
