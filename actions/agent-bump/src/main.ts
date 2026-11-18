/**
 * The scheduled dependency update of a repository (README.md), run by the
 * action (action.yml):
 *
 * 1. the update's branch checked: the job only replaces a branch it pushed
 *    itself, so a person's commits on it are never lost (pull-request.ts's
 *    `branchVerdict`);
 * 2. a sandbox on Atelier, as the service account whose key the job holds, from
 *    the repository's prebuild, with the update's branch made at the base
 *    branch's head;
 * 3. a task for its coding agent (pi), which finds what's outdated, reads the
 *    release notes, updates, migrates the configuration and replaces what the
 *    new versions deprecate, runs the checks and commits each update, then
 *    writes its result to a file (prompt.ts);
 * 4. the file read back and checked (bump-file.ts), and the commits too: on the
 *    branch, on top of the base, nothing left out of them;
 * 5. from the sandbox, with the service account's GitHub credential: the branch
 *    force-pushed, with a lease on the head the job saw, and the pull request
 *    opened or updated with `gh`, its body built by the job
 *    (pull-request.ts). The account pushes, not the job's token: the
 *    repository's workflows run on what it pushes, not on the token's;
 * 6. the sandbox destroyed, whatever happened.
 *
 * The mode is the first argument, else `MODE`, else `bump`. `cleanup` destroys
 * the update's sandboxes (the step that runs once the job is cancelled), and
 * `dry-run` updates but prints the pull request instead of pushing it.
 *
 * The agent's text is untrusted (a changelog can try to steer it): the job
 * posts it quieted, and checks the commits before pushing them.
 */
import { appendFile } from "node:fs/promises";
import { Atelier } from "../../shared/src/atelier.ts";
import { gitHub, statusOf } from "../../shared/src/github.ts";
import {
  isRepositoryPath,
  repositoryInstructions,
} from "../../shared/src/instructions.ts";
import { job, shellQuote } from "../../shared/src/job.ts";
import {
  deadlineIn,
  HOME,
  SANDBOX_NAME_MAX,
  sandboxes,
} from "../../shared/src/sandbox.ts";
import { type BumpFile, parseBumpFile } from "./bump-file.ts";
import {
  bumpPrompt,
  type Reply,
  SUBAGENT_SETTINGS,
  type SubagentSetting,
} from "./prompt.ts";
import {
  branchVerdict,
  brokeACheck,
  type Comment,
  conversation,
  type PullRequest,
  pullRequestBody,
} from "./pull-request.ts";

const { log, warn, notice, fail, env, minutes } = job(
  "agent-bump",
  "Dependency update",
);

const ATELIER = env("ATELIER_URL").replace(/\/+$/, "");
/** The base image the sandbox boots on: the repository's prebuild on it is
 * reused. */
const IMAGE = process.env.IMAGE || "dev-base";
const RESULT_FILE = `${HOME}/agent-bump.json`;
/** Outside the clone, so that nothing there ends up in a commit. */
const SCRATCH_DIR = `${HOME}/agent-bump-scratch`;
const BODY_FILE = `${HOME}/agent-bump-body.md`;
/** The agent's turns, past which the task is cancelled: the job's own timeout
 * is above this and the sandbox's boot. */
const TASK_MINUTES = minutes("AGENT_TIMEOUT_MINUTES", 90);
/** A release younger than this many days is too fresh to take. */
const MINIMUM_RELEASE_AGE = (() => {
  const value = Number(process.env.MINIMUM_RELEASE_AGE || 3);
  if (!Number.isInteger(value) || value < 0)
    fail("minimum-release-age must be a whole number of days");
  return value;
})();

/** The workflow's `subagents`: whether sub-agents read the release notes. */
const SUBAGENTS = (process.env.SUBAGENTS || "auto") as SubagentSetting;
if (!SUBAGENT_SETTINGS.includes(SUBAGENTS))
  fail(`subagents must be ${SUBAGENT_SETTINGS.join(", ")}, not "${SUBAGENTS}"`);
/** A model id or toolbox selector: it goes into the prompt and Atelier's
 * calls, so nothing but what one is made of. */
const ID = /^[\w.:@/+-]+$/;
const SUBAGENT_MODEL = process.env.SUBAGENT_MODEL?.trim() || undefined;
if (SUBAGENT_MODEL !== undefined && !ID.test(SUBAGENT_MODEL))
  fail(`subagent-model is no model id: "${SUBAGENT_MODEL}"`);
/** Toolboxes the sandbox gets on top of the org's auto-included ones (`whoami`
 * selectors), comma- or line-separated. */
const TOOLBOXES = (process.env.TOOLBOXES ?? "").split(/[\s,]+/).filter(Boolean);
for (const selector of TOOLBOXES)
  if (!ID.test(selector)) fail(`toolboxes: no toolbox selector: "${selector}"`);
/** Labels the pull request gets, comma- or line-separated: they must exist. */
const LABELS = (process.env.LABELS ?? "")
  .split(/[\n,]+/)
  .map((label) => label.trim())
  .filter(Boolean);
for (const label of LABELS)
  if (label.length > 50 || /\p{Cc}/u.test(label))
    fail(`labels: no label name: "${label}"`);
/** A branch name: it goes into git and gh commands. */
const BRANCH_NAME = /^(?!-)(?!.*\.\.)[\w./-]+$/;
const BRANCH = (process.env.BRANCH || "agent-bump").trim();
if (!BRANCH_NAME.test(BRANCH)) fail(`branch is no branch name: "${BRANCH}"`);
const BASE = process.env.BASE?.trim() || undefined;
if (BASE !== undefined && !BRANCH_NAME.test(BASE))
  fail(`base is no branch name: "${BASE}"`);
/** What the repository adds to the prompt, from its workflow and from a file
 * read on the base branch: the agent's commits can't change it. */
const INSTRUCTIONS = process.env.INSTRUCTIONS?.trim() ?? "";
const INSTRUCTIONS_FILE = (
  process.env.INSTRUCTIONS_FILE ?? "DEPENDENCIES.md"
).trim();
if (!isRepositoryPath(INSTRUCTIONS_FILE))
  fail(
    `instructions-file must be a path from the repository's root: "${INSTRUCTIONS_FILE}"`,
  );

const repository = env("GITHUB_REPOSITORY"); // owner/name
const [owner = "", repositoryName = repository] = repository.split("/");
const atelier = new Atelier(
  `${ATELIER}/mcp`,
  env(
    "ATELIER_API_KEY",
    "ATELIER_API_KEY is empty: the `api-key` secret isn't set, or doesn't reach this workflow " +
      "(on GitHub's free plan, an organization secret doesn't reach a private repository)",
  ),
  { name: "agent-bump", log },
);
const { request: github, all: githubAll } = gitHub({
  repository,
  token: env("GITHUB_TOKEN"),
  log,
});
const mode = process.argv[2] || process.env.MODE || "bump";
if (!["bump", "dry-run", "cleanup"].includes(mode))
  fail(`unknown mode: ${mode}`);
/** Every sandbox of the repository's updates carries it: how the next run, or
 * the cleanup step, finds the ones a dead job left. A dry run's are apart. */
const marker = {
  "agent-bump": `${repository}${mode === "dry-run" ? "-dry-run" : ""}`,
};
/**
 * Where the job leaves its sandbox's id, for the `cleanup` step of a cancelled
 * job (same job, same runner): a sandbox whose create job hasn't landed its
 * record isn't in Atelier's list yet. Not in a dry run.
 */
const sandboxIdFile =
  process.env.RUNNER_TEMP && mode !== "dry-run"
    ? `${process.env.RUNNER_TEMP}/agent-bump-sandbox`
    : undefined;
const { destroyAll, destroy, waitUntilRunning, exec, runTurn } = sandboxes(
  atelier,
  { log, warn },
  "the next run destroys it",
);
const runUrl = `${process.env.GITHUB_SERVER_URL}/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}/attempts/${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`;

/** The commit `branch` is at on GitHub, or undefined when it has none. */
async function branchHead(branch: string): Promise<string | undefined> {
  try {
    const ref = await github<{ object: { sha: string } }>(
      `/git/ref/heads/${branch}`,
    );
    return ref.object.sha;
  } catch (error) {
    if (statusOf(error) === 404) return undefined;
    throw error;
  }
}

/**
 * The sandbox's name: Atelier takes it as the create's idempotency key (a
 * retry gets the sandbox it made), so each run attempt has its own. The
 * repository's name is cut to fit.
 */
function sandboxName(): string {
  const prefix = "bump-";
  const suffix =
    mode === "dry-run"
      ? `-dry-${Date.now().toString(36)}`
      : `-${process.env.GITHUB_RUN_ID ?? Date.now().toString(36)}-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`;
  const room = SANDBOX_NAME_MAX - prefix.length - suffix.length;
  return `${prefix}${repositoryName.slice(0, room)}${suffix}`;
}

async function createSandbox(baseBranch: string): Promise<string> {
  const created = await atelier.call<{ id: string }>("create_sandbox", {
    name: sandboxName(),
    spec: { source: { image: IMAGE }, metadata: marker },
    ...(TOOLBOXES.length > 0 ? { toolboxes: TOOLBOXES } : {}),
    // The repository's prebuild of the base branch, or another switched to it.
    repo: { url: `https://github.com/${repository}.git`, branch: baseBranch },
  });
  log(`sandbox ${created.id} booting`);
  if (sandboxIdFile)
    await Bun.write(sandboxIdFile, created.id).catch((error) =>
      log(`sandbox id not left for a cancelled job's cleanup: ${error}`),
    );
  return created.id;
}

async function readResultFile(id: string): Promise<BumpFile> {
  const { files } = await atelier.call<{
    files: { content?: string; error?: string; truncated?: boolean }[];
  }>("read_files", { id, paths: [RESULT_FILE], maxBytes: 1_000_000 });
  const [file] = files;
  if (!file || file.content === undefined)
    throw new Error(`${RESULT_FILE}: ${file?.error ?? "missing"}`);
  if (file.truncated) throw new Error(`${RESULT_FILE} is over 1 MB`);
  return parseBumpFile(file.content);
}

/** Where the agent left the clone. */
interface GitState {
  head: string;
  branch: string;
  /** The base is an ancestor of the head: the commits are on top of it. */
  onBase: boolean;
  commits: number;
  /** `git status --porcelain`: what isn't committed. */
  uncommitted: string[];
}

async function gitState(
  id: string,
  cwd: string,
  base: string,
): Promise<GitState> {
  const out = await exec(
    id,
    `printf '%s\\n' "$(git rev-parse HEAD)" "$(git rev-parse --abbrev-ref HEAD)" ` +
      `"$(git merge-base --is-ancestor ${base} HEAD && echo yes || echo no)" "$(git rev-list --count ${base}..HEAD)" ` +
      "&& git status --porcelain",
    cwd,
  );
  const [head = "", branch = "", onBase = "", commits = "", ...uncommitted] =
    out.split("\n");
  return {
    head,
    branch,
    onBase: onBase === "yes",
    commits: Number(commits),
    uncommitted: uncommitted.filter(Boolean),
  };
}

/** What's wrong with `git` for the job to push it, if anything. */
function notReady(git: GitState): string | undefined {
  if (git.branch !== BRANCH)
    return `the clone is on ${git.branch}, not on ${BRANCH}`;
  if (git.uncommitted.length > 0)
    return `the working tree has changes nobody committed:\n${git.uncommitted.slice(0, 20).join("\n")}`;
  return undefined;
}

/**
 * Pushes the branch from the sandbox, with the service account's credential,
 * only if GitHub still has it at `expected` (undefined: no branch): a push to
 * it since the job looked isn't overwritten.
 */
async function push(
  id: string,
  cwd: string,
  expected: string | undefined,
): Promise<void> {
  const lease = `refs/heads/${BRANCH}:${expected ?? ""}`;
  try {
    await exec(
      id,
      `git push --quiet --force-with-lease=${shellQuote(lease)} origin ${shellQuote(`HEAD:refs/heads/${BRANCH}`)}`,
      cwd,
    );
  } catch (error) {
    const message = (error as Error).message;
    if (/workflow/i.test(message))
      throw new Error(
        "the service account's GitHub credential can't change workflow files: give its App the `workflows` " +
          `permission (a token, the \`workflow\` scope), or have ${INSTRUCTIONS_FILE} leave GitHub Actions alone. ${message}`,
      );
    if (/stale info/i.test(message))
      throw new Error(
        `${BRANCH} changed on GitHub during the run: not pushed. The next run looks again. ${message}`,
      );
    throw error;
  }
  log(`pushed ${BRANCH}`);
}

/**
 * Opens the pull request, or updates `open`, from the sandbox with `gh` (the
 * service account's credential): a draft while a check fails. Its number.
 */
async function openPullRequest(
  id: string,
  cwd: string,
  pr: {
    open?: PullRequest;
    baseBranch: string;
    title: string;
    body: string;
    draft: boolean;
  },
): Promise<number> {
  await atelier.call("write_files", {
    id,
    files: [{ path: BODY_FILE, content: pr.body }],
  });
  const repo = `--repo ${shellQuote(repository)}`;
  const content = `--title ${shellQuote(pr.title)} --body-file ${BODY_FILE}`;
  if (pr.open) {
    const { number, draft } = pr.open;
    const labels = LABELS.map((label) => ` --add-label ${shellQuote(label)}`);
    await exec(
      id,
      `gh pr edit ${number} ${repo} ${content}${labels.join("")}`,
      cwd,
    );
    if (pr.draft !== Boolean(draft))
      await exec(
        id,
        `gh pr ready ${number} ${repo}${pr.draft ? " --undo" : ""}`,
        cwd,
      );
    log(`#${number} updated`);
    return number;
  }
  const labels = LABELS.map((label) => ` --label ${shellQuote(label)}`);
  const url = await exec(
    id,
    `gh pr create ${repo} --base ${shellQuote(pr.baseBranch)} --head ${shellQuote(BRANCH)} ${content}` +
      `${pr.draft ? " --draft" : ""}${labels.join("")}`,
    cwd,
  );
  const number = Number(/\/pull\/(\d+)/.exec(url)?.[1]);
  if (!number) throw new Error(`gh pr create printed no pull request: ${url}`);
  log(`#${number} opened`);
  return number;
}

/** What people said on the open update: its comments, its review comments and
 * its reviews. */
async function peopleOn(pull: PullRequest): Promise<Reply[]> {
  return conversation([
    ...(await githubAll<Comment>(`/issues/${pull.number}/comments`)),
    ...(await githubAll<Comment>(`/pulls/${pull.number}/comments`)),
    ...(await githubAll<Comment>(`/pulls/${pull.number}/reviews`)),
  ]);
}

async function bump(): Promise<void> {
  const baseBranch =
    BASE ?? (await github<{ default_branch: string }>("")).default_branch;
  if (baseBranch === BRANCH)
    throw new Error(
      `branch and base are both ${BRANCH}: the update needs its own branch`,
    );
  const base = await branchHead(baseBranch);
  if (!base || !/^[0-9a-f]{40}$/.test(base))
    throw new Error(`${repository} has no branch ${baseBranch}`);
  // Before booting anything: a branch that isn't the job's stops the run.
  const head = await branchHead(BRANCH);
  const pulls = await githubAll<PullRequest>(
    `/pulls?state=all&head=${encodeURIComponent(`${owner}:${BRANCH}`)}`,
  );
  const verdict = branchVerdict(BRANCH, head, pulls);
  if (!verdict.ours) {
    notice(`No update this time: ${verdict.reason}.`);
    return;
  }
  const { open } = verdict;
  const people = open ? await peopleOn(open) : [];
  if (open)
    log(
      `#${open.number} is open: this run replaces it (${people.length} comments from people)`,
    );
  const recentCommits = (
    await github<{ sha: string; commit: { message: string } }[]>(
      `/commits?sha=${base}&per_page=15`,
    )
  ).map((c) => `${c.sha.slice(0, 7)} ${c.commit.message.split("\n")[0]}`);
  const instructions = await repositoryInstructions(
    { request: github },
    { log, warn },
    {
      inline: INSTRUCTIONS,
      file: INSTRUCTIONS_FILE,
      ref: base,
      fileSource: `on ${baseBranch}`,
    },
  );
  await destroyAll(marker);

  const sandboxId = await createSandbox(baseBranch).catch(async (error) => {
    // The call may have failed after Atelier created it: it has the marker.
    await destroyAll(marker).catch(() => {});
    throw error;
  });
  try {
    const sandboxUrl = `${ATELIER}/sandboxes/${sandboxId}/sessions`;
    notice(`Follow the agent on Atelier: ${sandboxUrl}`);
    await waitUntilRunning(sandboxId);
    const cwd = `${HOME}/${repositoryName}`;
    // The update's branch at the base's head, whatever the prebuild has: forced,
    // since its install can leave changes in the clone. Only that commit: the
    // clone is shallow.
    await exec(
      sandboxId,
      `git fetch --quiet --no-tags --depth 1 origin ${base} && git checkout --quiet --force -B ${shellQuote(BRANCH)} ${base} ` +
        `&& git clean --quiet -fd && mkdir -p ${SCRATCH_DIR}`,
      cwd,
    );
    const identity = await exec(
      sandboxId,
      "git config user.name && git config user.email",
      cwd,
    ).catch(() => "");
    if (!identity)
      throw new Error(
        "the sandbox has no git identity to commit with: give the service account a GitHub credential",
      );
    log(`${BRANCH} at ${base} in ${cwd}, committing as ${identity}`);
    // Before the agent's hour, not after: a credential that can't push.
    if (mode !== "dry-run")
      await exec(
        sandboxId,
        `git push --dry-run --quiet --force origin ${shellQuote(`HEAD:refs/heads/${BRANCH}`)}`,
        cwd,
      ).catch((error) => {
        throw new Error(
          `the service account can't push to ${repository}: its GitHub credential needs contents: write. ${(error as Error).message}`,
        );
      });

    const deadline = deadlineIn(TASK_MINUTES);
    const task = await runTurn(
      { sandboxId, cwd },
      bumpPrompt({
        repository,
        cwd,
        branch: BRANCH,
        base,
        baseBranch,
        minutes: TASK_MINUTES,
        minimumReleaseAge: MINIMUM_RELEASE_AGE,
        subagents: {
          setting: SUBAGENTS,
          ...(SUBAGENT_MODEL ? { model: SUBAGENT_MODEL } : {}),
        },
        recentCommits,
        ...(open
          ? { open: { number: open.number, conversation: people } }
          : {}),
        instructions,
        scratch: SCRATCH_DIR,
        output: RESULT_FILE,
      }),
      deadline,
    );
    let file: BumpFile;
    try {
      file = await readResultFile(sandboxId);
    } catch (error) {
      // One more turn, in the same context, to fix the file.
      log(
        `result file unusable (${(error as Error).message}): asking the agent again`,
      );
      await runTurn(
        { taskId: task.taskId },
        `${RESULT_FILE} can't be used: ${(error as Error).message}. Write it again as the schema says, ` +
          `check it with \`jq . ${RESULT_FILE}\`, then reply with the number of updates and held-back ones.`,
        deadline,
      );
      file = await readResultFile(sandboxId);
    }
    // The whole file, in one line: the run's log keeps it, whatever the body
    // had room for.
    console.log(`[agent-bump] result file: ${JSON.stringify(file)}`);

    let git = await gitState(sandboxId, cwd, base);
    const problem = notReady(git);
    if (problem) {
      log(`${problem.split("\n")[0]}: asking the agent again`);
      await runTurn(
        { taskId: task.taskId },
        `The clone isn't ready to push: ${problem}\nCommit what belongs to an update you listed, undo the rest ` +
          `or move it to ${SCRATCH_DIR}, stay on ${BRANCH}, and update ${RESULT_FILE} if that changes it. ` +
          "Reply once `git status --porcelain` prints nothing.",
        deadline,
      );
      file = await readResultFile(sandboxId);
      git = await gitState(sandboxId, cwd, base);
      const still = notReady(git);
      if (still) throw new Error(still);
    }
    await atelier
      .call("manage_task", { taskId: task.taskId, action: "close" })
      .catch(() => {});
    if (!git.onBase)
      throw new Error(`${BRANCH}'s commits aren't on top of ${base}`);
    if (git.commits === 0) {
      if (file.updates.length > 0)
        throw new Error(
          `the agent lists ${file.updates.length} updates, but committed none`,
        );
      notice(
        `Nothing to update on ${baseBranch}${file.held.length > 0 ? `, ${file.held.length} held back (the log's result file says why)` : ""}` +
          `${open ? `: #${open.number} is left as it is` : ""}.`,
      );
      return;
    }
    if (file.updates.length === 0)
      throw new Error(
        `the agent committed ${git.commits} commits, but lists no update`,
      );
    log(
      `${git.commits} commits on ${BRANCH}: ${await exec(sandboxId, `git log --format='%h %s' ${base}..HEAD | tr '\\n' ';'`, cwd)}`,
    );
    const draft = brokeACheck(file);
    if (draft)
      warn(
        "a check that passes on the base fails on the update: its pull request is a draft",
      );
    const body = pullRequestBody(file, {
      base,
      baseBranch,
      head: git.head,
      runUrl,
    });
    if (mode === "dry-run") {
      console.log(
        `${draft ? "[draft] " : ""}${file.title}\n\n${body}\n\n${await exec(sandboxId, `git diff --stat ${base} HEAD`, cwd)}`,
      );
      return;
    }
    await push(sandboxId, cwd, head);
    const number = await openPullRequest(sandboxId, cwd, {
      ...(open ? { open } : {}),
      baseBranch,
      title: file.title,
      body,
      draft,
    });
    const pull = await github<PullRequest & { html_url: string }>(
      `/pulls/${number}`,
    );
    if (pull.head.sha !== git.head)
      warn(
        `#${number}'s head is ${pull.head.sha}, not ${git.head} as pushed: GitHub may not have caught up`,
      );
    notice(
      `${file.updates.length} updates, ${file.held.length} held back: ${pull.html_url}`,
    );
    if (process.env.GITHUB_STEP_SUMMARY)
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        `[#${number} ${file.title}](${pull.html_url})\n\n${body}\n`,
      ).catch((error) => log(`no step summary: ${error}`));
  } finally {
    await destroy(sandboxId);
  }
}

try {
  if (mode === "cleanup") {
    // The job's sandbox, which Atelier may not list yet.
    const left = sandboxIdFile
      ? (
          await Bun.file(sandboxIdFile)
            .text()
            .catch(() => "")
        ).trim()
      : "";
    await destroyAll(marker, left ? [left] : []);
  } else await bump();
} catch (error) {
  fail((error as Error).message);
}
