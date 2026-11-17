/**
 * What a review leaves for the next one (README.md), so that it doesn't start
 * cold: the findings still open, the ones dismissed, and the head it saw,
 * hidden in its body as a gzipped, base64 HTML comment. Only the job's account
 * can write a review under the heading, so only the job's reviews are read
 * back.
 *
 * The next review rules on each open finding (fixed, open, dismissed), reviews
 * what changed since that head first, and the people's replies on a finding's
 * thread reach it with the finding: only those of people the repository trusts
 * (`trusted`), since one can dismiss a finding.
 */
import { gunzipSync, gzipSync } from "node:zlib";
import {
  type Closed,
  findingOf,
  HEADING,
  MAX_MINORS,
  type PostedComment,
  type PostedFinding,
  type PostedReview,
  type ReviewFile,
  SEVERITIES,
  type Severity,
  type Since,
} from "./github-review.ts";
import type { IssueComment } from "./progress.ts";

/** An open finding, as the next review gets it: where it was at
 * `ReviewState.head`. */
export interface StoredFinding {
  id: string;
  severity: Severity;
  title: string;
  body: string;
  path?: string;
  line?: number;
}

export interface ReviewState {
  /** The head the review saw. */
  head: string;
  /** The next new finding is F<nextId>: ids are never reused within a PR. */
  nextId: number;
  open: StoredFinding[];
  /** Dismissed in this review or an earlier one, the most recent last: not to
   * be reported again. */
  dismissed: Closed[];
}

/** A comment someone wrote on a finding's thread, or on the PR. */
export interface Reply {
  author: string;
  body: string;
}

const STATE = /<!-- agent-review-state:1:([A-Za-z0-9+/=]+) -->/g;
/** The state's room in the review's body (GitHub's limit is 65,536 characters),
 * the rest being the review's text. */
const MAX_STATE = 20_000;
/** The dismissed findings a state keeps: the most recent. */
const MAX_DISMISSED = 50;
/** The dismissed findings a state keeps when it is too big for the rest: it has
 * no open finding then. */
const MAX_DISMISSED_ALONE = 10;
/** A reply or a comment, as the prompt gets it. */
const MAX_REPLY = 2_000;

/**
 * The hidden block for `state`, as small as it fits: the findings' bodies cut,
 * then the open findings dropped and the dismissed ones cut to the last few,
 * then those dropped too. It always fits (what's left is a head and an id), so
 * a review always carries one: without it, the next review would start from an
 * older review's state, and take its findings, long fixed, for open ones.
 */
export function encodeState(state: ReviewState): string {
  const cut = (length: number) => ({
    ...state,
    open: state.open.map((finding) => ({
      ...finding,
      body: finding.body.slice(0, length),
    })),
  });
  const candidates = [
    state,
    cut(500),
    cut(0),
    {
      ...state,
      open: [],
      dismissed: state.dismissed.slice(-MAX_DISMISSED_ALONE),
    },
    { ...state, open: [], dismissed: [] },
  ];
  let block = "";
  for (const candidate of candidates) {
    const encoded = gzipSync(JSON.stringify(candidate)).toString("base64");
    block = `<!-- agent-review-state:1:${encoded} -->`;
    if (block.length <= MAX_STATE) break;
  }
  return block;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * The state hidden in a review's body, if it has a valid one: the last block,
 * since the job appends its own after everything the agent wrote (which can
 * quote one). Every field is checked: a review's body is read back by every
 * later review, and one invalid entry would break each of them.
 */
export function decodeState(body: string | null): ReviewState | undefined {
  const encoded = [...(body ?? "").matchAll(STATE)].at(-1)?.[1];
  if (!encoded) return undefined;
  try {
    const state: unknown = JSON.parse(
      gunzipSync(Buffer.from(encoded, "base64")).toString(),
    );
    if (!isObject(state)) return undefined;
    const { head, nextId, open, dismissed } = state;
    const valid =
      typeof head === "string" &&
      /^[0-9a-f]{40}$/.test(head) &&
      Number.isInteger(nextId) &&
      Array.isArray(open) &&
      open.every(
        (finding) =>
          isObject(finding) &&
          typeof finding.id === "string" &&
          /^F\d+$/.test(finding.id) &&
          SEVERITIES.includes(finding.severity as Severity) &&
          typeof finding.title === "string" &&
          typeof finding.body === "string" &&
          (finding.path === undefined || typeof finding.path === "string") &&
          (finding.line === undefined || Number.isInteger(finding.line)),
      ) &&
      Array.isArray(dismissed) &&
      dismissed.every(
        (item) =>
          isObject(item) &&
          typeof item.id === "string" &&
          typeof item.title === "string" &&
          typeof item.note === "string",
      );
    return valid ? (state as unknown as ReviewState) : undefined;
  } catch {
    return undefined;
  }
}

/** The latest agent review with a state, from `account` (the job's): what the
 * next review starts from. */
export function earlierReview(
  reviews: PostedReview[],
  account: string,
): { state: ReviewState; submittedAt?: string } | undefined {
  const ours = reviews
    .filter(
      (review) =>
        review.user?.login === account &&
        (review.body ?? "").startsWith(HEADING),
    )
    .sort((a, b) => b.id - a.id);
  for (const review of ours) {
    const state = decodeState(review.body);
    if (state)
      return {
        state,
        ...(review.submitted_at ? { submittedAt: review.submitted_at } : {}),
      };
  }
  return undefined;
}

/** The roles GitHub gives the repository's owners, its organization's members
 * and its collaborators (`author_association`). */
const TRUSTED_ROLES = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/**
 * Whether a comment reaches the next review: the PR's author's (`author`), and
 * those of the repository's owners, members and collaborators. A comment can
 * dismiss a finding (prompt.ts), and its text goes to the agent: anyone else's
 * (a stranger's on a public repository, another bot's) is left out.
 */
function trusted(
  comment: { user?: { login: string } | null; author_association?: string },
  author: string,
): boolean {
  return (
    (author !== "" && comment.user?.login === author) ||
    TRUSTED_ROLES.has(comment.author_association ?? "")
  );
}

const reply = (
  author: string | undefined,
  body: string | null | undefined,
): Reply => ({
  author: author ?? "someone",
  body: (body ?? "").trim().slice(0, MAX_REPLY),
});

/** People's replies on the threads of the job's finding comments, per finding
 * id, across every review that posted it: the trusted ones (`trusted`, with the
 * PR's `author`). */
export function threadReplies(
  comments: PostedComment[],
  account: string,
  author: string,
): Map<string, Reply[]> {
  const findings = new Map<number, string>();
  for (const comment of comments) {
    const id = findingOf(comment.body);
    if (
      comment.in_reply_to_id === undefined &&
      comment.user?.login === account &&
      id
    )
      findings.set(comment.id, id);
  }
  const replies = new Map<string, Reply[]>();
  for (const comment of comments) {
    const id =
      comment.in_reply_to_id === undefined
        ? undefined
        : findings.get(comment.in_reply_to_id);
    if (!id || comment.user?.login === account || !trusted(comment, author))
      continue;
    replies.set(id, [
      ...(replies.get(id) ?? []),
      reply(comment.user?.login, comment.body),
    ]);
  }
  return replies;
}

/**
 * People's comments on the PR's conversation that the next review gets: the
 * last 20 since `since` (ISO time), and every one naming an open finding
 * (`open`, their ids) whatever its date. A minor finding has no thread
 * (github-review.ts), so a comment is the only way to answer it, and one
 * written while a review ran is older than that review. Only the trusted ones
 * (`trusted`, with the PR's `author`).
 */
export function conversationSince(
  comments: IssueComment[],
  since: string | undefined,
  open: readonly string[],
  account: string,
  author: string,
): Reply[] {
  // Ids are `F<n>` (decodeState checks them): nothing to escape, and `\b` keeps
  // F1 from matching F12.
  const naming =
    open.length > 0 ? new RegExp(`\\b(?:${open.join("|")})\\b`) : undefined;
  const people = comments.filter(
    (comment) =>
      comment.user?.login !== account &&
      comment.created_at !== undefined &&
      trusted(comment, author),
  );
  const recent = new Set(
    people
      .filter(
        (comment) =>
          since === undefined || (comment.created_at as string) > since,
      )
      .slice(-20),
  );
  return people
    .filter(
      (comment) => recent.has(comment) || naming?.test(comment.body ?? ""),
    )
    .map((comment) => reply(comment.user?.login, comment.body));
}

/**
 * The agent's review merged with the earlier one: its new findings get the next
 * ids, the ones it carries keep theirs. A first review keeps its first
 * `MAX_MINORS` new minor findings, a later one none (prompt.ts): the others are
 * `dropped`, and get no id. An earlier finding it calls open without writing it
 * again, or doesn't rule on, is posted as it was, off the diff's lines (they
 * may have moved). Returns what to post, what became of the earlier findings,
 * and the state for the next.
 */
export function resolve(
  result: ReviewFile,
  earlier: ReviewState | undefined,
  head: string,
): {
  findings: PostedFinding[];
  dropped: number;
  since?: Since;
  state: ReviewState;
} {
  let nextId = earlier?.nextId ?? 1;
  let minorsLeft = earlier ? 0 : MAX_MINORS;
  const kept = result.findings.filter(
    (finding) =>
      finding.previous !== undefined ||
      finding.severity !== "minor" ||
      minorsLeft-- > 0,
  );
  const findings: PostedFinding[] = kept.map(({ previous, ...finding }) => ({
    ...finding,
    id: previous ?? `F${nextId++}`,
  }));
  const carried = new Set(kept.flatMap((finding) => finding.previous ?? []));
  const verdicts = new Map(
    result.previous.map((verdict) => [verdict.id, verdict]),
  );
  const since: Since | undefined = earlier && {
    head: earlier.head,
    fixed: [],
    dismissed: [],
    open: [],
    unchecked: [],
  };
  for (const old of earlier?.open ?? []) {
    const verdict = verdicts.get(old.id);
    const closed = { id: old.id, title: old.title, note: verdict?.note ?? "" };
    if (carried.has(old.id)) since?.open.push(old.id);
    else if (verdict?.status === "fixed") since?.fixed.push(closed);
    else if (verdict?.status === "dismissed") since?.dismissed.push(closed);
    else {
      const { line: _line, ...asItWas } = old;
      findings.push(asItWas);
      (verdict ? since?.open : since?.unchecked)?.push(old.id);
    }
  }
  const stored = findings.map(({ id, severity, title, body, path, line }) => ({
    id: id as string,
    severity,
    title,
    body,
    ...(path ? { path } : {}),
    ...(line ? { line } : {}),
  }));
  return {
    findings,
    dropped: result.findings.length - kept.length,
    ...(since ? { since } : {}),
    state: {
      head,
      nextId,
      open: stored,
      dismissed: [
        ...(earlier?.dismissed ?? []),
        ...(since?.dismissed ?? []),
      ].slice(-MAX_DISMISSED),
    },
  };
}
