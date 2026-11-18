/**
 * The update's pull request: its body, built from the agent's file
 * (bump-file.ts), and the state the job hides in it, which tells a later run
 * whether the branch is still its own to replace (`branchVerdict`).
 *
 * One branch carries the update, run after run: each run starts again from the
 * base branch's head and force-pushes it, so an update left open for weeks
 * stays one pull request, up to date. The job never pushes over a person's
 * commits: once someone pushes to the branch, it's theirs until the pull
 * request is merged or closed. (The agent holds the credential, and one steered
 * into misusing it isn't bound by this: the base branch's rules are.)
 */
import { closeFences, quiet } from "../../shared/src/markdown.ts";
import {
  type BumpFile,
  type CheckStatus,
  type Update,
  type UpdateKind,
  updateKind,
} from "./bump-file.ts";
import type { Reply } from "./prompt.ts";

export const HEADING = "### Dependency updates";

/** What the job hides in the body: the commits it pushed the branch from and
 * to. */
export interface BumpState {
  base: string;
  head: string;
  /** The branch's head before the push. The body of an open pull request is
   * written before the push, so that a push that lands is always recorded:
   * the branch is at `previous` until it does, or if it fails. */
  previous?: string;
}

const STATE = /<!-- agent-bump-state (\{[^<>]*\}) -->/g;
const SHA = /^[0-9a-f]{40}$/;
const isSha = (value: unknown): value is string =>
  typeof value === "string" && SHA.test(value);

export function encodeState(state: BumpState): string {
  return `<!-- agent-bump-state ${JSON.stringify(state)} -->`;
}

/** The state in a pull request's body: its last marker, the footer's. The
 * agent's text comes before the footer, so a marker it wrote (a code span keeps
 * `<!--`) can't stand for the job's. */
export function decodeState(
  body: string | null | undefined,
): BumpState | undefined {
  const match = [...(body ?? "").matchAll(STATE)].at(-1);
  if (!match?.[1]) return undefined;
  try {
    const { base, head, previous } = JSON.parse(match[1]) as Partial<BumpState>;
    if (isSha(base) && isSha(head))
      return { base, head, ...(isSha(previous) ? { previous } : {}) };
  } catch {}
  return undefined;
}

/** A pull request from the update's branch, as GitHub lists them. */
export interface PullRequest {
  number: number;
  state: "open" | "closed";
  draft?: boolean;
  title?: string;
  body: string | null;
  head: { sha: string };
}

export type Verdict =
  /** The job may force-push the branch: to update `open`, or to start over. */
  { ours: true; open?: PullRequest } | { ours: false; reason: string };

/**
 * Whether the job may replace the update's branch, now at `branchHead`
 * (undefined: there's none), given the pull requests from it, any order. It
 * may when the branch is at the head the job last pushed, or was about to push
 * from (`previous`), as the newest of them records: an open one (it's updated),
 * or a merged or closed one (its branch was left). A branch at any other head
 * has someone's commits, or isn't the job's at all.
 */
export function branchVerdict(
  branch: string,
  branchHead: string | undefined,
  pulls: readonly PullRequest[],
): Verdict {
  if (branchHead === undefined) return { ours: true };
  const open = pulls.find((pull) => pull.state === "open");
  const newest = open ?? pulls.toSorted((a, b) => b.number - a.number)[0];
  const state = decodeState(newest?.body);
  const pushed =
    state !== undefined &&
    (state.head === branchHead || state.previous === branchHead);
  if (newest && pushed && newest.head.sha === branchHead)
    return open ? { ours: true, open } : { ours: true };
  return {
    ours: false,
    reason: open
      ? `#${open.number} has commits the job didn't push: it's left alone until it's merged or closed`
      : `the branch ${branch} exists, and isn't one the job pushed: delete it, or set \`branch\` to another`,
  };
}

/** A comment on the pull request, its conversation or its diff, or a review,
 * as GitHub lists them. */
export interface Comment {
  user: { login: string; type?: string } | null;
  body?: string | null;
  created_at?: string;
  submitted_at?: string;
  author_association?: string;
}

/** The repository's owners, its organization's members and its collaborators
 * (`author_association`): anyone else's comment could steer the agent. */
const TRUSTED_ROLES = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
/** The comments the agent gets, at most: the last ones. */
const MAX_COMMENTS = 30;
/** A comment's characters, at most. */
const MAX_COMMENT = 2_000;

/** What people said on the open update, oldest first, for the agent: no bot's
 * comment (the job's and the reviewers'), no stranger's. */
export function conversation(comments: readonly Comment[]): Reply[] {
  return comments
    .filter(
      (comment) =>
        comment.user &&
        comment.user.type !== "Bot" &&
        TRUSTED_ROLES.has(comment.author_association ?? "") &&
        comment.body?.trim(),
    )
    .map((comment) => ({
      at: comment.created_at ?? comment.submitted_at ?? "",
      author: comment.user?.login ?? "",
      body: (comment.body ?? "").trim().slice(0, MAX_COMMENT),
    }))
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(-MAX_COMMENTS)
    .map(({ author, body }) => ({ author, body }));
}

/** Whether the update goes up as a draft: a check its commits broke. The agent
 * is told to undo such an update, so it's a slip worth a person's look. */
export const brokeACheck = (file: BumpFile) =>
  file.checks.some((check) => check.status === "failed");

/** GitHub's limit on a body is 65,536 characters: room for the footer. */
const MAX_BODY = 60_000;

const KIND_ORDER: (UpdateKind | undefined)[] = [
  "major",
  "minor",
  "patch",
  undefined,
];

const CHECK_ICONS: Record<CheckStatus, string> = {
  passed: "✅",
  failed: "❌",
  "pre-existing": "⚠️",
  skipped: "⏭️",
};

/** Text on one line, for a table's cell or a list's item: quiet, its pipes
 * escaped (a table's cell ends at one, and elsewhere `\|` reads `|`). */
function cell(text: string): string {
  return quiet(text).replaceAll(/\s+/g, " ").replaceAll("|", "\\|");
}

/**
 * A name or a command as code, on one line. Not quieted: a code span shows
 * HTML as text and notifies no @mention, and a zero-width space in a package's
 * name would break copying it. In a table, its pipes are escaped (GitHub reads
 * `\|` in a cell's code as `|`); elsewhere, a backslash would show.
 */
function code(text: string, inTable = false): string {
  const line = text.replaceAll("`", "").replaceAll(/\s+/g, " ");
  return `\`${inTable ? line.replaceAll("|", "\\|") : line}\``;
}

/** The update's body: the agent's summary, a table of the updates (majors
 * first), what each took, what's held back, the checks, and the state. */
export function pullRequestBody(
  file: BumpFile,
  run: {
    base: string;
    baseBranch: string;
    head: string;
    /** The branch's head before the push, if it has one. */
    previous?: string;
    /** The workflow run, linked from the footer: none on a local dry run. */
    runUrl?: string;
  },
): string {
  const kinds = new Map(
    file.updates.map((update) => [update, updateKind(update.from, update.to)]),
  );
  const updates = file.updates.toSorted(
    (a, b) =>
      KIND_ORDER.indexOf(kinds.get(a)) - KIND_ORDER.indexOf(kinds.get(b)) ||
      a.name.localeCompare(b.name),
  );
  const row = (update: Update) => {
    const kind = kinds.get(update);
    const extra = [
      kind === "major" ? "**major**" : kind,
      update.changelog ? `[changes](${update.changelog})` : undefined,
    ].filter(Boolean);
    return `| ${code(update.name, true)} | ${cell(update.ecosystem)} | ${cell(update.from)} | ${cell(update.to)} | ${extra.join(" · ")} |`;
  };
  const sections = [
    HEADING,
    quiet(file.summary),
    [
      "| Dependency | Ecosystem | From | To | |",
      "| --- | --- | --- | --- | --- |",
      ...updates.map(row),
    ].join("\n"),
  ];
  const notes = updates.filter((update) => update.notes);
  if (notes.length > 0)
    sections.push(
      "#### What each update took",
      notes
        .map(
          (update) =>
            `**${code(update.name)}** ${cell(update.from)} → ${cell(update.to)}\n\n${quiet(update.notes ?? "")}`,
        )
        .join("\n\n"),
    );
  if (file.held.length > 0)
    sections.push(
      "#### Held back",
      file.held
        .map(
          (held) =>
            `- ${code(held.name)} (${cell(held.ecosystem)}) ${cell(held.from)}${held.to ? ` → ${cell(held.to)}` : ""}: ${cell(held.reason)}`,
        )
        .join("\n"),
    );
  if (file.checks.length > 0)
    sections.push(
      "#### Checks",
      [
        ...(brokeACheck(file)
          ? [
              "A check passes on the base and fails here: this pull request is a draft until someone looks.\n",
            ]
          : []),
        ...file.checks.map(
          (check) =>
            `- ${CHECK_ICONS[check.status]} ${code(check.command)} ${check.status === "pre-existing" ? "fails on the base too" : check.status}${check.note ? `: ${cell(check.note)}` : ""}`,
        ),
      ].join("\n"),
    );
  const footer =
    `<sub>Updated from \`${run.base.slice(0, 7)}\` (${cell(run.baseBranch)}) by a coding agent on Atelier, which read the ` +
    `release notes: check its notes against them before merging.${run.runUrl ? ` <a href="${run.runUrl}">Run</a>` : ""}</sub>\n\n` +
    encodeState({
      base: run.base,
      head: run.head,
      ...(run.previous ? { previous: run.previous } : {}),
    });
  let body = sections.join("\n\n");
  if (body.length > MAX_BODY)
    body = `${closeFences(body.slice(0, MAX_BODY))}\n\n… cut here: the run's log has the agent's whole file.`;
  return `${body}\n\n${footer}`;
}
