/**
 * The agent review of a pull request (README.md), run by the action
 * (action.yml):
 *
 * 1. a sandbox on Atelier, as the service account whose key the job holds, from
 *    the repository's prebuild, at the PR's head;
 * 2. the PR's diff written to files there (diff-files.sh), since the agent's
 *    sub-agents can't run git;
 * 3. a task for its coding agent (pi), which reviews the PR's diff (merge base
 *    to head) with sub-agents and writes its findings to a file (prompt.ts).
 *    After an earlier agent review, it gets that review's open findings, the
 *    replies to them and what changed since (memory.ts);
 * 4. the file read back, checked, and posted as one review on the PR with the
 *    job's token (github-review.ts), with what the next review starts from
 *    hidden in it; the earlier reviews are collapsed;
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
import { Atelier } from "./atelier.ts";
import {
  buildReview,
  commentableLines,
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
import {
  conversationSince,
  decodeState,
  earlierReview,
  encodeState,
  type ReviewState,
  resolve,
  threadReplies,
} from "./memory.ts";
import {
  type IssueComment,
  JOB_ACCOUNT,
  type Progress,
  progressComment,
  progressCommentId,
} from "./progress.ts";
import { type EarlierReview, reviewPrompt } from "./prompt.ts";
import { MAX_RATE_LIMIT_WAIT_MS, rateLimitWait } from "./rate-limit.ts";

/** `text` on one line: messages carry the agent's text and servers', and the
 * job reads a line starting with `::` as a command. */
function oneLine(text: string): string {
  return text.replaceAll(/\s+/g, " ");
}

const log = (message: string) =>
  console.log(`[agent-review] ${oneLine(message)}`);

/** An annotation on the run (a workflow command), on one line. `%` is the
 * commands' escape character. */
function annotate(kind: "error" | "warning" | "notice", message: string) {
  console.log(
    `::${kind} title=Agent review::${oneLine(message).replaceAll("%", "%25")}`,
  );
}

/** A warning on the run, not a red check: for what goes wrong around the
 * review, not in it. */
const warn = (message: string) => annotate("warning", message);
const notice = (message: string) => annotate("notice", message);

/** Ends the run red, with `message` on its summary. */
function fail(message: string): never {
  annotate("error", message);
  process.exit(1);
}

function env(name: string, unset = `${name} is not set`): string {
  const value = process.env[name];
  if (!value) fail(unset);
  return value;
}

/** A whole number of minutes from `name`, else `fallback`. */
function minutes(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    fail(`${name} must be a whole number of minutes`);
  return parsed;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

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
/** The home of `dev`, the user Atelier runs a sandbox's agent as, and where it
 * clones a repository. */
const HOME = "/home/dev";
const REVIEW_FILE = `${HOME}/agent-review.json`;
/** Where diff-files.sh writes the diff: outside the clone, so it's no change to
 * review. */
const DIFF_DIR = `${HOME}/agent-review-diff`;
/** The agent's turns, past which the task is cancelled: the job's own timeout
 * is above this and the sandbox's boot. */
const TASK_MINUTES = minutes("AGENT_TIMEOUT_MINUTES", 40);
const TASK_TIMEOUT_MS = TASK_MINUTES * 60_000;
const BOOT_TIMEOUT_MS = 10 * 60_000;
/** How long a destroy waits for a sandbox whose create job hasn't landed its
 * record yet (`destroySandbox`). */
const DESTROY_WAIT_MS = 5 * 60_000;
/** Atelier's limit on a sandbox's name (`SANDBOX_NAME_MAX_LENGTH`). */
const SANDBOX_NAME_MAX = 64;

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
);
const githubToken = env("GITHUB_TOKEN");
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

/** GitHub's GETs are sent again after a network or server error, like Atelier's
 * read-only calls. */
const RETRY_DELAYS_MS = [5_000, 15_000];
/** How many times one request waits out a rate limit before the run fails. */
const RATE_LIMIT_RETRIES = 3;
const runUrl = runLink(
  `${process.env.GITHUB_SERVER_URL}`,
  repository,
  `${process.env.GITHUB_RUN_ID}`,
  process.env.GITHUB_RUN_ATTEMPT ?? "1",
);

/** A GitHub request that failed: its status, if GitHub answered, and the wait
 * a rate limit asks for. */
class GitHubError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/**
 * Sends a GitHub request (`send`, called again for each attempt). A rate limit
 * is waited out, up to RATE_LIMIT_RETRIES times and MAX_RATE_LIMIT_WAIT_MS each:
 * the refused request did nothing, so any request is sent again, a POST too.
 * After a network or server error, it's sent again after each of `delays`: only
 * a GET's are given, since anything else may have been done.
 */
async function sendWithRetries<T>(
  label: string,
  send: () => Promise<T>,
  delays: readonly number[],
): Promise<T> {
  let failures = 0;
  let limited = 0;
  for (;;) {
    try {
      return await send();
    } catch (error) {
      const { status, retryAfterMs } = error as Partial<GitHubError>;
      if (
        retryAfterMs !== undefined &&
        retryAfterMs <= MAX_RATE_LIMIT_WAIT_MS &&
        limited < RATE_LIMIT_RETRIES
      ) {
        limited++;
        log(
          `GitHub rate limit on ${label}: sending it again in ${Math.ceil(retryAfterMs / 1000)} s`,
        );
        await sleep(retryAfterMs);
        continue;
      }
      const delay = delays[failures++];
      // A refusal (4xx) won't change; a network error or a 5xx may.
      if (delay === undefined || (status !== undefined && status < 500))
        throw error;
      log(
        `GitHub ${label} failed (${(error as Error).message}), retrying in ${delay / 1000} s`,
      );
      await sleep(delay);
    }
  }
}

function github<T>(path: string, init: RequestInit = {}): Promise<T> {
  return sendWithRetries(
    `${init.method ?? "GET"} ${path}`,
    () => githubOnce<T>(path, init),
    init.method === undefined ? RETRY_DELAYS_MS : [],
  );
}

async function githubOnce<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(
    `https://api.github.com/repos/${repository}${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...init.headers,
      },
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new GitHubError(
      `GitHub ${init.method ?? "GET"} ${path}: ${response.status} ${text}`,
      response.status,
      rateLimitWait(response, text),
    );
  }
  // A DELETE answers 204, with no body.
  return (response.status === 204 ? undefined : await response.json()) as T;
}

const COLLAPSE = `mutation($id: ID!) {
    minimizeComment(input: { subjectId: $id, classifier: OUTDATED }) { minimizedComment { isMinimized } }
}`;

/** Every page of a GitHub list. */
async function githubAll<T>(path: string): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page++) {
    const batch = await github<T[]>(`${path}?per_page=100&page=${page}`);
    items.push(...batch);
    if (batch.length < 100) return items;
  }
}

function graphql<T>(
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  return sendWithRetries("GraphQL", () => graphqlOnce<T>(query, variables), []);
}

async function graphqlOnce<T>(
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${githubToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  let result: { data?: T; errors?: { type?: string; message: string }[] } = {};
  try {
    result = JSON.parse(text);
  } catch {}
  if (!response.ok || result.errors?.length || result.data === undefined) {
    // The primary limit answers 200, with a RATE_LIMITED error.
    const limited = result.errors?.some((e) => e.type === "RATE_LIMITED");
    throw new GitHubError(
      `GitHub GraphQL: ${response.status} ${result.errors?.map((e) => e.message).join("; ") ?? text}`,
      response.status,
      limited
        ? rateLimitWait({ status: 429, headers: response.headers }, text)
        : rateLimitWait(response, text),
    );
  }
  return result.data;
}

/** Destroys the review sandboxes Atelier lists with `metadata`, and the ones
 * in `known` (it can't list one whose record hasn't landed yet). */
async function destroyReviewSandboxes(
  metadata: Record<string, string>,
  known: readonly string[] = [],
): Promise<void> {
  const { sandboxes } = await atelier.call<{ sandboxes: { id: string }[] }>(
    "get_sandbox",
    { metadata },
  );
  const ids = new Set([...known, ...sandboxes.map(({ id }) => id)]);
  for (const id of ids) {
    log(`destroying sandbox ${id}`);
    await destroySandbox(id);
  }
}

/**
 * Destroys sandbox `id`; never throws. Until its create job lands its record
 * (once the source is resolved: baking a missing prebuild takes minutes),
 * Atelier can't destroy it, though `get_sandbox` finds it, `creating`: the
 * destroy is tried again until it lands, DESTROY_WAIT_MS at most. Past that, a
 * warning: the PR's next run, or its close, destroys it
 * (`destroyReviewSandboxes`).
 */
async function destroySandbox(id: string): Promise<void> {
  const deadline = Date.now() + DESTROY_WAIT_MS;
  for (;;) {
    try {
      await atelier.call("destroy_sandbox", { id });
      log(`sandbox ${id} destroyed`);
      return;
    } catch (error) {
      const exists = await atelier
        .call("get_sandbox", { id })
        .then(() => true)
        .catch(() => false);
      if (!exists) {
        // Gone already, or never made: nothing to destroy.
        log(`sandbox ${id} not destroyed: ${error}`);
        return;
      }
      if (Date.now() > deadline) {
        warn(
          `sandbox ${id} not destroyed (${error}): the PR's next run, or its close, destroys it`,
        );
        return;
      }
      log(`sandbox ${id} not destroyed yet (${error}): trying again`);
      await sleep(15_000);
    }
  }
}

async function createSandbox(headRef: string, head: string): Promise<string> {
  const created = await atelier.call<{ id: string }>("create_sandbox", {
    name: sandboxName(head),
    spec: { source: { image: IMAGE }, metadata: headMarker(head) },
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

async function waitForSandbox(id: string): Promise<void> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  for (;;) {
    const { status } = await atelier.call<{ status: string }>("get_sandbox", {
      id,
      waitSeconds: 50,
      until: "running",
    });
    if (status === "running") return;
    if (status === "error" || status === "stopped")
      throw new Error(`sandbox ${id} is ${status}`);
    if (Date.now() > deadline)
      throw new Error(`sandbox ${id} still ${status} after the boot timeout`);
  }
}

async function exec(id: string, command: string, cwd: string): Promise<string> {
  const result = await atelier.call<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>("exec", {
    id,
    command,
    cwd,
    // Under the client's 120 s per request: `exec` isn't retried.
    timeoutMs: 100_000,
  });
  if (result.exitCode !== 0)
    throw new Error(
      `\`${command}\` exited ${result.exitCode}: ${result.stderr.trim()}`,
    );
  return result.stdout.trim();
}

interface Task {
  taskId: string;
  status: "running" | "idle" | "failed" | "cancelled";
  turn: {
    reply?: string;
    error?: string;
    toolCalls?: { title: string; status: string }[];
  };
}

/**
 * Sends the prompt (a new task in the sandbox, or a follow-up turn of `taskId`)
 * and waits for the agent's turn, until `deadline`: the turns of one review
 * share it, so they fit in the job's timeout.
 */
async function runTurn(
  target: { sandboxId: string; cwd: string } | { taskId: string },
  prompt: string,
  deadline: number,
): Promise<Task> {
  let task = await atelier.call<Task>("send_prompt", { ...target, prompt });
  let logged = 0;
  while (task.status === "running") {
    if (Date.now() > deadline) {
      await atelier
        .call("manage_task", { taskId: task.taskId, action: "cancel" })
        .catch(() => {});
      throw new Error(
        `the agent took longer than ${TASK_TIMEOUT_MS / 60_000} minutes`,
      );
    }
    task = await atelier.call<Task>("get_task", {
      taskId: task.taskId,
      waitSeconds: 50,
    });
    // The job's log tells what the agent did: each tool call once (the list
    // only comes with a running turn).
    const calls = task.turn.toolCalls ?? [];
    for (const call of calls.slice(logged))
      log(`agent: ${call.title.replaceAll("\n", " ").slice(0, 160)}`);
    logged = Math.max(logged, calls.length);
  }
  if (task.status !== "idle")
    throw new Error(
      `the agent's task is ${task.status}: ${task.turn.error ?? ""}`,
    );
  log(`agent done: ${task.turn.reply ?? ""}`);
  return task;
}

async function readReviewFile(
  id: string,
  earlier: ReadonlySet<string>,
): Promise<ReviewFile> {
  const { files } = await atelier.call<{
    files: { content?: string; error?: string; truncated?: boolean }[];
  }>("read_files", { id, paths: [REVIEW_FILE], maxBytes: 1_000_000 });
  const [file] = files;
  if (!file || file.content === undefined)
    throw new Error(`${REVIEW_FILE}: ${file?.error ?? "missing"}`);
  if (file.truncated) throw new Error(`${REVIEW_FILE} is over 1 MB`);
  return parseReviewFile(file.content, `${HOME}/${repositoryName}`, earlier);
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

    const deadline = Date.now() + TASK_TIMEOUT_MS;
    const task = await runTurn(
      { sandboxId, cwd },
      reviewPrompt({
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
        ...(earlier ? { earlier: { ...earlier.prompt, delta } } : {}),
        output: REVIEW_FILE,
      }),
      deadline,
    );
    const earlierIds = new Set(
      earlier?.state.open.map((finding) => finding.id),
    );
    let result: ReviewFile;
    try {
      result = await readReviewFile(sandboxId, earlierIds);
    } catch (error) {
      // One more turn, in the same context, to fix the file.
      log(
        `review file unusable (${(error as Error).message}): asking the agent again`,
      );
      await runTurn(
        { taskId: task.taskId },
        `${REVIEW_FILE} can't be used: ${(error as Error).message}. Write it again as the schema says, ` +
          `check it with \`jq . ${REVIEW_FILE}\`, then reply with the number of findings per severity.`,
        deadline,
      );
      result = await readReviewFile(sandboxId, earlierIds);
    }
    await atelier
      .call("manage_task", { taskId: task.taskId, action: "close" })
      .catch(() => {});
    // The whole file, in one line: the run's log keeps every review, whatever
    // happens to the comments.
    console.log(`[agent-review] review file: ${JSON.stringify(result)}`);

    const {
      findings,
      dropped,
      since: changes,
      state,
    } = resolve(result, earlier?.state, head);
    // Past the minor findings this review may report (prompt.ts): in the log's
    // review file above, not on the PR.
    if (dropped > 0)
      log(`${dropped} minor findings dropped: past what this review reports`);
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
