/**
 * What became of the agents' findings on a repository's merged pull requests:
 * how many were fixed, dismissed, or still open at merge, per severity of issue
 * and per category of improvement (README.md, *Measure*). Nothing is stored for it: each review hides its state
 * (memory.ts), with the findings open at its head and the ones dismissed, and a
 * finding that left the open ones without being dismissed was fixed. *Fixed* is
 * the agent's ruling, at the review that followed the fix.
 *
 *   GITHUB_TOKEN=$(gh auth token) bun src/stats.ts owner/repo [closed PRs: 100]
 *
 * Prints a markdown table (for `$GITHUB_STEP_SUMMARY` as well), and its
 * progress on stderr.
 */

import {
  MAX_RATE_LIMIT_WAIT_MS,
  rateLimitWait,
} from "../../shared/src/rate-limit.ts";
import {
  CATEGORIES,
  type Category,
  HEADING,
  type PostedReview,
  SEVERITIES,
  type Severity,
} from "./github-review.ts";
import { decodeState } from "./memory.ts";
import { JOB_ACCOUNT } from "./progress.ts";

type Outcome = "fixed" | "dismissed" | "open";

/** A merged PR's agent findings. */
export interface PullFindings {
  /** Its agent reviews: the rounds it took. */
  reviews: number;
  /** Its last review saw an older head than the merged one: what that review
   * left open may have been fixed since. */
  stale: boolean;
  /** Each finding, with its severity when first posted, and an improvement's
   * category. */
  findings: {
    id: string;
    severity: Severity;
    category?: Category;
    outcome: Outcome;
  }[];
}

/**
 * What became of the findings of a PR merged at `head`, from its reviews by
 * `account` (the job's), oldest first: open in the last review's state, else
 * dismissed in any, else fixed. Undefined when the agent never reviewed it.
 */
export function pullFindings(
  reviews: PostedReview[],
  account: string,
  head: string,
): PullFindings | undefined {
  const states = reviews
    .filter(
      (review) =>
        review.user?.login === account &&
        (review.body ?? "").startsWith(HEADING),
    )
    .sort((a, b) => a.id - b.id)
    .flatMap((review) => decodeState(review.body) ?? []);
  const last = states.at(-1);
  if (!last) return undefined;
  const first = new Map<string, { severity: Severity; category?: Category }>();
  for (const state of states)
    for (const { id, severity, category } of state.open)
      if (!first.has(id))
        first.set(id, { severity, ...(category ? { category } : {}) });
  const open = new Set(last.open.map((finding) => finding.id));
  const dismissed = new Set(
    states.flatMap((state) => state.dismissed.map((item) => item.id)),
  );
  return {
    reviews: states.length,
    stale: last.head !== head,
    findings: [...first].map(([id, kind]) => ({
      id,
      ...kind,
      outcome: open.has(id)
        ? "open"
        : dismissed.has(id)
          ? "dismissed"
          : "fixed",
    })),
  };
}

/** The table for `pulls`, the reviewed ones among `merged` merged PRs. */
export function findingsReport(
  repository: string,
  merged: number,
  pulls: PullFindings[],
): string {
  const rounds = pulls.reduce((sum, pull) => sum + pull.reviews, 0);
  const clean = pulls.filter((pull) => pull.findings.length === 0).length;
  const stale = pulls.filter((pull) => pull.stale).length;
  const all = pulls.flatMap((pull) => pull.findings);
  const row = (label: string, findings: PullFindings["findings"]) => {
    const count = (outcome: Outcome) =>
      findings.filter((finding) => finding.outcome === outcome).length;
    const rate =
      findings.length > 0
        ? `${Math.round((100 * count("fixed")) / findings.length)}%`
        : "–";
    return `| ${label} | ${findings.length} | ${count("fixed")} | ${count("dismissed")} | ${count("open")} | ${rate} |`;
  };
  const reviewed =
    pulls.length > 0
      ? `, ${pulls.length} reviewed by the agent (${(rounds / pulls.length).toFixed(1)} reviews each on average, ${clean} with no finding)`
      : ", none reviewed by the agent";
  return [
    `### Agent review findings on ${repository}`,
    `${merged} merged PRs${reviewed}.${
      stale > 0
        ? ` ${stale} got a push their last review didn't see: what it left open may be fixed.`
        : ""
    }`,
    "",
    "| Kind | Found | Fixed | Dismissed | Open at merge | Fixed rate |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...SEVERITIES.map((severity) =>
      row(
        severity,
        all.filter(
          (finding) => !finding.category && finding.severity === severity,
        ),
      ),
    ),
    ...CATEGORIES.map((category) =>
      row(
        category,
        all.filter((finding) => finding.category === category),
      ),
    ),
    row("all", all),
    "",
    "*Fixed* is the agent's ruling, at the review after the fix. *Dismissed*: deferred by a person, or found wrong by a later review.",
  ].join("\n");
}

/** A GET on GitHub's API, sent again after a rate limit or a server error. */
async function get<T>(token: string, path: string): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(`https://api.github.com${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(60_000),
    });
    if (response.ok) return (await response.json()) as T;
    const text = await response.text();
    const wait = rateLimitWait(response, text);
    const again =
      attempt <= 3 &&
      (wait === undefined
        ? response.status >= 500
        : wait <= MAX_RATE_LIMIT_WAIT_MS);
    if (!again)
      throw new Error(`GitHub GET ${path}: ${response.status} ${text}`);
    const delay = wait ?? attempt * 5_000;
    console.error(
      `GitHub GET ${path}: ${response.status}, again in ${Math.ceil(delay / 1000)} s`,
    );
    await Bun.sleep(delay);
  }
}

async function getAll<T>(token: string, path: string): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page++) {
    const batch = await get<T[]>(token, `${path}?per_page=100&page=${page}`);
    items.push(...batch);
    if (batch.length < 100) return items;
  }
}

if (import.meta.main) {
  const [repository = process.env.GITHUB_REPOSITORY ?? "", count = "100"] =
    process.argv.slice(2);
  const token = process.env.GITHUB_TOKEN;
  const limit = Number(count);
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
    !token ||
    !Number.isInteger(limit) ||
    limit < 1
  ) {
    console.error(
      "usage: GITHUB_TOKEN=... bun src/stats.ts owner/repo [closed PRs to read: 100]",
    );
    process.exit(2);
  }
  interface Pull {
    number: number;
    merged_at: string | null;
    head: { sha: string };
  }
  const closed: Pull[] = [];
  for (let page = 1; closed.length < limit; page++) {
    const batch = await get<Pull[]>(
      token,
      `/repos/${repository}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`,
    );
    closed.push(...batch);
    if (batch.length < 100) break;
  }
  const merged = closed.slice(0, limit).filter((pull) => pull.merged_at);
  const pulls: PullFindings[] = [];
  for (const [index, pull] of merged.entries()) {
    console.error(`[${index + 1}/${merged.length}] #${pull.number}`);
    const reviews = await getAll<PostedReview>(
      token,
      `/repos/${repository}/pulls/${pull.number}/reviews`,
    );
    const found = pullFindings(reviews, JOB_ACCOUNT, pull.head.sha);
    if (found) pulls.push(found);
  }
  console.log(findingsReport(repository, merged.length, pulls));
}
