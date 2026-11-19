/**
 * The review the agent writes (`ReviewFile`), checked, and turned into one
 * GitHub pull request review: a summary that says whether the findings block
 * the merge, with the counts per severity, and a comment on the diff's lines
 * for each critical or major finding GitHub accepts one on. A finding on a line
 * the diff doesn't show (GitHub refuses the whole review for one such comment)
 * goes into the summary instead. Minor findings are never comments: they're
 * listed at the end of the summary, collapsed, so that they don't bury the ones
 * that matter. A finding's evidence (how the agent confirmed it) is collapsed
 * under it.
 *
 * Each finding has an id (F1, F2…, per PR) that later reviews keep: the next
 * one says what became of it (fixed, still open, dismissed), from what
 * memory.ts hides in the review's body.
 */
import { closeFences, quiet } from "../../shared/src/markdown.ts";

export const SEVERITIES = ["critical", "major", "minor"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** The minor findings a first review reports at most; later reviews report no
 * new one (prompt.ts, memory.ts). */
export const MAX_MINORS = 5;

export interface Finding {
  severity: Severity;
  title: string;
  body: string;
  /** Relative to the repository's root. Without it, the finding is about the PR
   * as a whole. */
  path?: string;
  /** Line in the file at the PR's head (the diff's right side). */
  line?: number;
  /** First line of a range ending at `line`. */
  startLine?: number;
  /** Replacement for lines `startLine`..`line`: a GitHub suggestion, only on an
   * inline comment. */
  suggestion?: string;
  /** How the agent confirmed it (the code path, the case that triggers it):
   * shown collapsed, for whoever doubts it. */
  evidence?: string;
  /** The id of the earlier review's finding this one is, still open: it keeps
   * that id. */
  previous?: string;
}

const STATUSES = ["fixed", "open", "dismissed"] as const;
type Status = (typeof STATUSES)[number];

/** What became of a finding of the earlier review, and why, in a line. */
interface Verdict {
  id: string;
  status: Status;
  note: string;
}

export interface ReviewFile {
  summary: string;
  findings: Finding[];
  /** One per finding of the earlier review the agent ruled on: none on a first
   * review. */
  previous: Verdict[];
}

/**
 * The agent's file, checked field by field: what it wrote is a model's output.
 * Throws with what's wrong. `root` is the repository's directory in the
 * sandbox, stripped from a path the agent wrote absolute. `earlier` holds the
 * ids of the earlier review's open findings, the only ones it can rule on or
 * carry.
 */
export function parseReviewFile(
  text: string,
  root: string,
  earlier: ReadonlySet<string> = new Set(),
): ReviewFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`not JSON: ${(error as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null) throw new Error("not an object");
  const { summary, findings, previous } = raw as Record<string, unknown>;
  if (typeof summary !== "string" || summary.trim() === "")
    throw new Error("`summary` must be a non-empty string");
  if (!Array.isArray(findings)) throw new Error("`findings` must be an array");
  if (previous !== undefined && previous !== null && !Array.isArray(previous)) {
    throw new Error("`previous` must be an array");
  }
  const verdicts = ((previous ?? []) as unknown[]).map((verdict, index) =>
    parseVerdict(verdict, `previous[${index}]`, earlier),
  );
  const status = new Map<string, Status>();
  for (const [index, verdict] of verdicts.entries()) {
    if (status.has(verdict.id))
      throw new Error(`previous[${index}]: ${verdict.id} is ruled on twice`);
    status.set(verdict.id, verdict.status);
  }
  const parsed = findings.map((finding, index) =>
    parseFinding(finding, `findings[${index}]`, root, earlier),
  );
  const carried = new Set<string>();
  for (const [index, finding] of parsed.entries()) {
    if (finding.previous === undefined) continue;
    const where = `findings[${index}].previous`;
    if (carried.has(finding.previous))
      throw new Error(`${where}: ${finding.previous} is carried twice`);
    const ruled = status.get(finding.previous);
    if (ruled !== undefined && ruled !== "open")
      throw new Error(`${where}: ${finding.previous} is ${ruled}`);
    carried.add(finding.previous);
  }
  return { summary: summary.trim(), findings: parsed, previous: verdicts };
}

function parseVerdict(
  raw: unknown,
  where: string,
  earlier: ReadonlySet<string>,
): Verdict {
  if (typeof raw !== "object" || raw === null)
    throw new Error(`${where} is not an object`);
  const { id, status, note } = raw as Record<string, unknown>;
  if (typeof id !== "string" || !earlier.has(id))
    throw new Error(`${where}.id is no finding of the earlier review`);
  if (!STATUSES.includes(status as Status))
    throw new Error(`${where}.status must be one of ${STATUSES}`);
  if (note !== undefined && note !== null && typeof note !== "string")
    throw new Error(`${where}.note is invalid`);
  return {
    id,
    status: status as Status,
    note: ((note as string | null | undefined) ?? "").trim(),
  };
}

function parseFinding(
  raw: unknown,
  where: string,
  root: string,
  earlier: ReadonlySet<string>,
): Finding {
  if (typeof raw !== "object" || raw === null)
    throw new Error(`${where} is not an object`);
  // Models write `null` for a field that doesn't apply: it's absent.
  const field = (name: string) =>
    ((raw as Record<string, unknown>)[name] ?? undefined) as unknown;
  const [
    severity,
    title,
    body,
    path,
    line,
    startLine,
    suggestion,
    evidence,
    previous,
  ] = [
    "severity",
    "title",
    "body",
    "path",
    "line",
    "startLine",
    "suggestion",
    "evidence",
    "previous",
  ].map(field);
  if (!SEVERITIES.includes(severity as Severity))
    throw new Error(`${where}.severity must be one of ${SEVERITIES}`);
  if (typeof title !== "string" || title.trim() === "")
    throw new Error(`${where}.title must be a non-empty string`);
  if (typeof body !== "string")
    throw new Error(`${where}.body must be a string`);
  const isLine = (value: unknown) =>
    value === undefined || (Number.isInteger(value) && (value as number) > 0);
  // A path is shown in a code span: one that could close it could post
  // anything.
  if (
    path !== undefined &&
    (typeof path !== "string" || !/^[^`\s][^`\n\r]*$/.test(path))
  ) {
    throw new Error(`${where}.path is invalid`);
  }
  if (!isLine(line) || !isLine(startLine))
    throw new Error(`${where}: lines are positive integers`);
  if (suggestion !== undefined && typeof suggestion !== "string")
    throw new Error(`${where}.suggestion is invalid`);
  if (evidence !== undefined && typeof evidence !== "string")
    throw new Error(`${where}.evidence must be a string`);
  if (
    previous !== undefined &&
    (typeof previous !== "string" || !earlier.has(previous))
  ) {
    throw new Error(
      `${where}.previous is no open finding of the earlier review`,
    );
  }
  // A range that ends before its start: its suggestion was written for lines we
  // can't tell, so it goes.
  const backwards =
    startLine !== undefined &&
    line !== undefined &&
    (startLine as number) > (line as number);
  return {
    severity: severity as Severity,
    title: title.trim(),
    body: body.trim(),
    ...(path
      ? {
          path: (path as string)
            .replace(`${root.replace(/\/$/, "")}/`, "")
            .replace(/^\.?\//, ""),
        }
      : {}),
    ...(line ? { line: line as number } : {}),
    ...(startLine && line && (startLine as number) < (line as number)
      ? { startLine: startLine as number }
      : {}),
    ...(suggestion !== undefined && !backwards
      ? { suggestion: suggestion as string }
      : {}),
    ...((evidence as string | undefined)?.trim()
      ? { evidence: (evidence as string).trim() }
      : {}),
    ...(previous !== undefined ? { previous: previous as string } : {}),
  };
}

/**
 * The lines of each file a review comment can be on, from the PR's files
 * (GitHub's `patch`, a unified diff without its headers): the head's lines the
 * diff adds or shows as context, each with its hunk, since a range can't span
 * two. A file without a patch (binary, or too big for GitHub to show) has none.
 */
export function commentableLines(
  files: { filename: string; patch?: string }[],
): Map<string, Map<number, number>> {
  const lines = new Map<string, Map<number, number>>();
  for (const file of files) {
    const fileLines = new Map<number, number>();
    let hunk = -1;
    let right = 0;
    for (const text of (file.patch ?? "").split("\n")) {
      const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
      if (header) {
        hunk += 1;
        right = Number(header[1]);
      } else if (hunk >= 0 && (text.startsWith("+") || text.startsWith(" "))) {
        fileLines.set(right, hunk);
        right += 1;
      }
      // `-` lines are the base's only, `\ No newline at end of file` neither
      // side's.
    }
    lines.set(file.filename, fileLines);
  }
  return lines;
}

interface ReviewComment {
  path: string;
  line: number;
  side: "RIGHT";
  start_line?: number;
  start_side?: "RIGHT";
  body: string;
}

export interface PullRequestReview {
  body: string;
  comments: ReviewComment[];
}

/** How every agent review starts: how a later run tells them from a person's,
 * or another workflow's. */
export const HEADING = "### Agent review";

/** A review on the PR, as GitHub lists it. */
export interface PostedReview {
  id: number;
  node_id: string;
  body: string | null;
  user: { login: string } | null;
  submitted_at?: string | null;
  commit_id?: string;
}

/**
 * A run attempt's page: the link in its review's footer and its progress
 * comment. The attempt is part of it: a re-run keeps the run's id, and on the
 * same head would otherwise take the first attempt's review for its own
 * (`postedByRun`).
 */
export function runLink(
  serverUrl: string,
  repository: string,
  runId: string,
  attempt: string,
): string {
  return `${serverUrl}/${repository}/actions/runs/${runId}/attempts/${attempt}`;
}

/**
 * The review a run posted, if GitHub made it: `account`'s, on `head`, under the
 * heading, with the run attempt's link (`runLink`) in its footer. How a run
 * tells, after an error that doesn't say, whether its review is up.
 */
export function postedByRun(
  reviews: PostedReview[],
  account: string,
  head: string,
  runUrl: string,
): PostedReview | undefined {
  return reviews.find(
    (review) =>
      review.user?.login === account &&
      review.commit_id === head &&
      (review.body ?? "").startsWith(HEADING) &&
      (review.body ?? "").includes(`<a href="${runUrl}">Run</a>`),
  );
}

/** A comment on the PR's lines, as GitHub lists it: a reply has
 * `in_reply_to_id`, its thread's first comment. */
export interface PostedComment {
  id: number;
  node_id: string;
  pull_request_review_id: number | null;
  in_reply_to_id?: number;
  body?: string;
  user?: { login: string } | null;
  /** The author's role in the repository, as GitHub tells. */
  author_association?: string;
}

/** Ends a finding's comment: how the next review finds the replies to finding
 * `id`. */
export const findingMarker = (id: string) =>
  `<!-- agent-review-finding:${id} -->`;

/** The id of the finding a comment is, from its marker. */
export function findingOf(body: string | undefined): string | undefined {
  return /<!-- agent-review-finding:(F\d+) -->\s*$/.exec(body ?? "")?.[1];
}

/**
 * What leaves only `latest` in view once it's posted: the earlier agent
 * reviews' summaries and comments are collapsed as outdated, not deleted, so
 * the PR keeps its history (GitHub can't delete a submitted review anyway).
 * People's replies stay as they are. Only the reviews before `latest`, from its
 * account, under the heading.
 */
export function supersede(
  latest: PostedReview,
  reviews: PostedReview[],
  comments: PostedComment[],
): string[] {
  const earlier = reviews.filter(
    (review) =>
      review.id < latest.id &&
      review.user?.login === latest.user?.login &&
      (review.body ?? "").startsWith(HEADING),
  );
  const earlierIds = new Set(earlier.map((review) => review.id));
  const theirs = comments.filter(
    (comment) =>
      comment.in_reply_to_id === undefined &&
      comment.pull_request_review_id !== null &&
      earlierIds.has(comment.pull_request_review_id),
  );
  return [
    ...earlier.map((review) => review.node_id),
    ...theirs.map((comment) => comment.node_id),
  ];
}

const ICONS: Record<Severity, string> = {
  critical: "🔴",
  major: "🟠",
  minor: "🟡",
};
const LABELS: Record<Severity, string> = {
  critical: "Critical",
  major: "Major",
  minor: "Minor",
};
/** GitHub's limit on a review's body is 65,536 characters: room for the footer.
 */
const MAX_BODY = 60_000;

/** A finding as posted: its id, when it has one, is what later reviews and
 * replies refer to. */
export type PostedFinding = Omit<Finding, "previous"> & { id?: string };

const headline = (finding: PostedFinding) =>
  `${ICONS[finding.severity]} **${LABELS[finding.severity]}${finding.id ? ` · ${finding.id}` : ""}: ${quiet(finding.title)}**`;

/** A code block of `code`, its fence longer than any run of backticks in it, or
 * one in it would close the block. */
function codeBlock(code: string, info: string): string {
  const longestRun = Math.max(
    0,
    ...(code.match(/`+/g) ?? []).map((run) => run.length),
  );
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${info}\n${code}\n${fence}`;
}

/** The finding's evidence, collapsed under it: our own `<details>`, since
 * quiet() turns any the agent wrote into text, and closes its fences so that
 * none swallows the `</details>`. */
function evidence(finding: PostedFinding): string {
  return finding.evidence
    ? `\n\n<details><summary>Evidence</summary>\n\n${quiet(finding.evidence)}\n\n</details>`
    : "";
}

function inlineBody(finding: PostedFinding, withSuggestion: boolean): string {
  const heading = `${headline(finding)}\n\n${quiet(finding.body)}`;
  const text =
    !withSuggestion || finding.suggestion === undefined
      ? heading
      : `${heading}\n\n${codeBlock(finding.suggestion, "suggestion")}`;
  const withEvidence = `${text}${evidence(finding)}`;
  return finding.id
    ? `${withEvidence}\n\n${findingMarker(finding.id)}`
    : withEvidence;
}

function location(finding: PostedFinding): string {
  if (!finding.path) return "";
  const lines = finding.line
    ? `:${finding.startLine ? `${finding.startLine}-` : ""}${finding.line}`
    : "";
  return ` \`${finding.path}${lines}\``;
}

/** An earlier finding that is no longer open: its id, its title, and why, in a
 * line. */
export interface Closed {
  id: string;
  title: string;
  note: string;
}

/** What became of the earlier review's findings. */
export interface Since {
  /** The head the earlier review saw. */
  head: string;
  fixed: Closed[];
  dismissed: Closed[];
  /** Still open: posted again with this review's findings. */
  open: string[];
  /** Not ruled on by the agent: posted again as they were. */
  unchecked: string[];
}

export interface ReviewToPost {
  summary: string;
  findings: PostedFinding[];
  since?: Since;
  /** memory.ts's hidden block, for the next review. */
  state?: string;
}

function sinceSection(since: Since): string[] {
  const closed = (icon: string, word: string) => (item: Closed) =>
    `- ${icon} **${item.id}** ${word}: ${quiet(item.title)}${item.note ? `. ${quiet(item.note)}` : ""}`;
  const lines = [
    ...since.fixed.map(closed("✅", "fixed")),
    ...since.dismissed.map(closed("💤", "dismissed")),
  ];
  if (since.open.length > 0)
    lines.push(`- 🔁 Still open: ${since.open.join(", ")}.`);
  if (since.unchecked.length > 0) {
    lines.push(
      `- ❔ Not checked again, posted as they were: ${since.unchecked.join(", ")}.`,
    );
  }
  if (lines.length === 0) return [];
  return [
    `#### Since the review of \`${since.head.slice(0, 7)}\``,
    lines.join("\n"),
  ];
}

/**
 * The review to post: each finding on a commentable line becomes a comment
 * there (a range when its start is in the same hunk, else its last line alone);
 * the others are listed in the body. `footer` says what reviewed which commits.
 */
export function buildReview(
  review: ReviewToPost,
  commentable: Map<string, Map<number, number>>,
  footer: string,
): PullRequestReview {
  const severityOrder = (finding: PostedFinding) =>
    SEVERITIES.indexOf(finding.severity);
  const findings = [...review.findings].sort(
    (a, b) => severityOrder(a) - severityOrder(b),
  );
  const comments: ReviewComment[] = [];
  const elsewhere: PostedFinding[] = [];
  const minors: PostedFinding[] = [];
  for (const finding of findings) {
    if (finding.severity === "minor") {
      minors.push(finding);
      continue;
    }
    const hunk =
      finding.path && finding.line
        ? commentable.get(finding.path)?.get(finding.line)
        : undefined;
    if (!finding.path || !finding.line || hunk === undefined) {
      elsewhere.push(finding);
      continue;
    }
    const ranged =
      finding.startLine !== undefined &&
      commentable.get(finding.path)?.get(finding.startLine) === hunk;
    comments.push({
      path: finding.path,
      line: finding.line,
      side: "RIGHT",
      ...(ranged
        ? { start_line: finding.startLine, start_side: "RIGHT" as const }
        : {}),
      // A suggestion replaces exactly the lines commented on: not when a range
      // fell back to its last line.
      body: inlineBody(finding, ranged || finding.startLine === undefined),
    });
  }

  const count = (severity: Severity) =>
    findings.filter((finding) => finding.severity === severity).length;
  const counts = SEVERITIES.map(
    (severity) => `${ICONS[severity]} ${count(severity)} ${severity}`,
  ).join(" · ");
  // Any critical or major finding blocks: minor ones are the author's to take
  // or leave.
  const verdict =
    findings.length === 0
      ? "✅ **LGTM**: nothing flagged."
      : minors.length < findings.length
        ? `🛑 **Blocking**: ${counts}`
        : `✅ **Not blocking**: ${ICONS.minor} ${minors.length} minor, optional`;
  const listItem = (finding: PostedFinding) => {
    // Off the diff's lines, a suggestion can't be a GitHub suggestion: the
    // change, to apply by hand.
    const suggestion =
      finding.suggestion === undefined
        ? ""
        : `\n\nSuggested change:\n\n${codeBlock(finding.suggestion, "")}`;
    const text = `${quiet(finding.body)}${suggestion}${evidence(finding)}`;
    return `- ${headline(finding)}${location(finding)}\n\n  ${text.replaceAll("\n", "\n  ")}`;
  };
  let body = [
    HEADING,
    verdict,
    quiet(review.summary),
    ...(review.since ? sinceSection(review.since) : []),
    ...(elsewhere.length > 0
      ? ["#### Not on the diff's lines", elsewhere.map(listItem).join("\n\n")]
      : []),
    // Our own HTML: quiet() turns any the agent wrote into text, so this
    // `<details>` is the only one.
    ...(minors.length > 0
      ? [
          `<details><summary>${ICONS.minor} ${minors.length} minor, optional</summary>`,
          minors.map(listItem).join("\n\n"),
          "</details>",
        ]
      : []),
  ].join("\n\n");
  const room = MAX_BODY - (review.state?.length ?? 0);
  if (body.length > room) {
    const cut = closeFences(body.slice(0, room));
    // Cut inside the minor findings, or a finding's evidence: closed, or the
    // footer would be hidden with them. Every `<details>` is ours (quiet()).
    const open = cut.split("<details>").length - cut.split("</details>").length;
    body = `${cut}${"\n\n</details>".repeat(Math.max(0, open))}\n\n… (cut: too long for GitHub)`;
  }
  return {
    body: `${body}\n\n<sub>${footer}</sub>${review.state ? `\n\n${review.state}` : ""}`,
    comments,
  };
}

/** The same review with every comment listed in the body: what's posted when
 * GitHub refuses the comments. */
export function withoutComments(
  review: ReviewToPost,
  footer: string,
): PullRequestReview {
  return buildReview(review, new Map(), footer);
}
