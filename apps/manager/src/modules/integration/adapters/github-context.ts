import type {
  IntegrationContext,
  IntegrationEvent,
  IntegrationMessage,
} from "../integration.types.ts";
import type {
  DiscussionQueryResult,
  GitHubApiClient,
  GitHubIntegrationContext,
  GitHubIssueComment,
  GitHubIssueResponse,
  GitHubPullFile,
  GitHubPullRequestResponse,
  GitHubPullReviewComment,
  GitHubRawEvent,
  LinkedIssueSummary,
} from "./github.types.ts";

const MAX_LINKED_ISSUES = 3;
const MAX_LINKED_ISSUE_COMMENTS = 2;
const MAX_THREAD_COMMENTS = 30;
const KEEP_FIRST_COMMENTS = 5;
const MAX_CHANGED_FILES = 50;

const NOISE_WORDS = new Set([
  "lgtm",
  "lfg",
  "gtm",
  "ship it",
  "shipit",
  "+1",
  "bump",
  "nice",
  "noice",
  "dope",
  "sweet",
  "yep",
  "yup",
  "nah",
  "nope",
  "same",
  "this",
  "wow",
  "cool",
  "neat",
  "ty",
  "thx",
  "thanks",
  "thank you",
]);

const EMOJI_ONLY = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+$/u;

/* ---- Comment filtering ------------------------------------------------- */

function isNoiseBody(body?: string): boolean {
  if (!body) return true;
  const trimmed = body.trim();
  if (!trimmed) return true;
  const normalized = trimmed.toLowerCase().replace(/[!.]+$/, "");
  if (NOISE_WORDS.has(normalized)) return true;
  if (EMOJI_ONLY.test(trimmed)) return true;
  return false;
}

function isBotLogin(login?: string): boolean {
  if (!login) return false;
  return login.endsWith("[bot]") || login.endsWith("-bot");
}

function filterAndCap<T>(
  items: T[],
  getBody: (item: T) => string | undefined,
  getUserLogin: (item: T) => string | undefined,
  getId: (item: T) => number,
  triggeringId: number,
): T[] {
  const filtered = items.filter((item) => {
    if (getId(item) === triggeringId) return true;
    if (isBotLogin(getUserLogin(item))) return false;
    if (isNoiseBody(getBody(item))) return false;
    return true;
  });

  if (filtered.length <= MAX_THREAD_COMMENTS) return filtered;

  const keepLast = MAX_THREAD_COMMENTS - KEEP_FIRST_COMMENTS;
  const first = filtered.slice(0, KEEP_FIRST_COMMENTS);
  const last = filtered.slice(-keepLast);

  const trigIdx = filtered.findIndex((c) => getId(c) === triggeringId);
  const inGap =
    trigIdx >= KEEP_FIRST_COMMENTS && trigIdx < filtered.length - keepLast;
  if (inGap) {
    const trigComment = filtered[trigIdx];
    if (trigComment) {
      return [...first, trigComment, ...last];
    }
  }

  return [...first, ...last];
}

/* ---- Context extraction ------------------------------------------------ */

export async function extractIssueContext(
  client: GitHubApiClient,
  event: IntegrationEvent,
  raw: GitHubRawEvent,
): Promise<GitHubIntegrationContext> {
  const allComments = await client
    .fetch<GitHubIssueComment[]>(
      `/repos/${raw.owner}/${raw.repo}/issues/${raw.number}/comments?per_page=100`,
    )
    .then((r) => r ?? []);

  const comments = filterAndCap(
    allComments,
    (c) => c.body,
    (c) => c.user?.login,
    (c) => c.id,
    raw.commentId,
  );

  const messages: IntegrationMessage[] = [];
  if (raw.title || raw.body) {
    const prefix = raw.title ? `${raw.title}\n\n` : "";
    messages.push({
      user: raw.authorLogin ?? "unknown",
      text: `${prefix}${raw.body ?? ""}`.trim(),
    });
  }
  messages.push(...comments.map(toMessage));

  const triggering = allComments.find((c) => c.id === raw.commentId);

  return {
    messages,
    currentRequest: {
      user: triggering?.user?.login ?? event.user,
      text: triggering?.body ?? event.text,
    },
    github: {
      contextType: "issue",
      number: raw.number,
      title: raw.title,
      labels: raw.labels,
    },
  };
}

export async function extractPrContext(
  client: GitHubApiClient,
  event: IntegrationEvent,
  raw: GitHubRawEvent,
): Promise<GitHubIntegrationContext> {
  const repoPath = `/repos/${raw.owner}/${raw.repo}`;
  const [pr, issueComments, reviewComments, files] = await Promise.all([
    client.fetch<GitHubPullRequestResponse>(`${repoPath}/pulls/${raw.number}`),
    client
      .fetch<GitHubIssueComment[]>(
        `${repoPath}/issues/${raw.number}/comments?per_page=100`,
      )
      .then((r) => r ?? []),
    client
      .fetch<GitHubPullReviewComment[]>(
        `${repoPath}/pulls/${raw.number}/comments?per_page=100`,
      )
      .then((r) => r ?? []),
    client
      .fetch<GitHubPullFile[]>(
        `${repoPath}/pulls/${raw.number}/files?per_page=${MAX_CHANGED_FILES}`,
      )
      .then((r) => r ?? []),
  ]);

  const title = raw.title ?? pr?.title;
  const body = raw.body ?? pr?.body;
  const authorLogin = raw.authorLogin ?? pr?.user?.login;
  const labels = raw.labels ?? extractLabelNames(pr?.labels);

  const messages: IntegrationMessage[] = [];
  if (title || body) {
    const prefix = title ? `${title}\n\n` : "";
    messages.push({
      user: authorLogin ?? "unknown",
      text: `${prefix}${body ?? ""}`.trim(),
    });
  }

  const merged = [...issueComments, ...reviewComments].sort((a, b) => {
    const aTs = a.created_at ? Date.parse(a.created_at) : 0;
    const bTs = b.created_at ? Date.parse(b.created_at) : 0;
    return aTs - bTs;
  });

  const filtered = filterAndCap(
    merged,
    (c) => c.body,
    (c) => c.user?.login,
    (c) => c.id,
    raw.commentId,
  );
  messages.push(...filtered.map(toMessage));

  const triggering = merged.find((c) => c.id === raw.commentId);

  const linkedIssues = await extractLinkedIssues(
    client,
    raw.owner,
    raw.repo,
    raw.number,
    body,
  );

  const headBranch = raw.headBranch ?? pr?.head?.ref;
  const baseBranch = raw.baseBranch ?? pr?.base?.ref;

  return {
    messages,
    currentRequest: {
      user: triggering?.user?.login ?? event.user,
      text: triggering?.body ?? event.text,
    },
    github: {
      contextType: "pr",
      number: raw.number,
      title,
      labels,
      headBranch,
      baseBranch,
      changedFiles: files
        .map((f) => f.filename)
        .filter((name): name is string => !!name),
      linkedIssues: linkedIssues.length > 0 ? linkedIssues : undefined,
    },
  };
}

export async function extractPrReviewContext(
  client: GitHubApiClient,
  event: IntegrationEvent,
  raw: GitHubRawEvent,
): Promise<GitHubIntegrationContext> {
  const comments = await client
    .fetch<GitHubPullReviewComment[]>(
      `/repos/${raw.owner}/${raw.repo}/pulls/${raw.number}/comments?per_page=100`,
    )
    .then((r) => r ?? []);

  const trigger = comments.find((c) => c.id === raw.commentId);
  const rootId = trigger?.in_reply_to_id ?? trigger?.id;

  const threadComments =
    rootId === undefined
      ? comments
      : comments.filter((c) => c.id === rootId || c.in_reply_to_id === rootId);

  threadComments.sort((a, b) => {
    const aTs = a.created_at ? Date.parse(a.created_at) : 0;
    const bTs = b.created_at ? Date.parse(b.created_at) : 0;
    return aTs - bTs;
  });

  const filtered = filterAndCap(
    threadComments,
    (c) => c.body,
    (c) => c.user?.login,
    (c) => c.id,
    raw.commentId,
  );

  const messages = filtered.map(toMessage);

  return {
    messages,
    currentRequest: {
      user: trigger?.user?.login ?? event.user,
      text: trigger?.body ?? event.text,
    },
    github: {
      contextType: "pr_review",
      number: raw.number,
      title: raw.title,
      headBranch: raw.headBranch,
      baseBranch: raw.baseBranch,
      diffHunk: raw.diffHunk ?? trigger?.diff_hunk,
      path: raw.path ?? trigger?.path,
      line: raw.line ?? trigger?.line,
    },
  };
}

export async function extractDiscussionContext(
  client: GitHubApiClient,
  event: IntegrationEvent,
  raw: GitHubRawEvent,
): Promise<GitHubIntegrationContext> {
  const result = await client.graphql<DiscussionQueryResult>(
    `query GetDiscussionComments(
        $owner: String!
        $repo: String!
        $number: Int!
      ) {
        repository(owner: $owner, name: $repo) {
          discussion(number: $number) {
            comments(first: 100) {
              nodes {
                id
                databaseId
                body
                author { login }
                createdAt
              }
            }
          }
        }
      }`,
    {
      owner: raw.owner,
      repo: raw.repo,
      number: raw.number,
    },
  );

  const nodes = result?.repository?.discussion?.comments?.nodes ?? [];

  const filteredNodes = filterAndCap(
    nodes,
    (n) => n.body,
    (n) => n.author?.login,
    (n) => n.databaseId ?? 0,
    raw.commentId,
  );

  const messages: IntegrationMessage[] = [];
  if (raw.title || raw.body) {
    const prefix = raw.title ? `${raw.title}\n\n` : "";
    messages.push({
      user: raw.authorLogin ?? "unknown",
      text: `${prefix}${raw.body ?? ""}`.trim(),
    });
  }

  for (const node of filteredNodes) {
    messages.push({
      user: node.author?.login ?? "unknown",
      text: node.body ?? "",
      timestamp: node.createdAt,
    });
  }

  const triggering = nodes.find((c) => c.databaseId === raw.commentId);

  return {
    messages,
    currentRequest: {
      user: triggering?.author?.login ?? event.user,
      text: triggering?.body ?? event.text,
    },
    github: {
      contextType: "discussion",
      number: raw.number,
      title: raw.title,
      labels: raw.labels,
      category: raw.discussionCategory,
    },
  };
}

async function extractLinkedIssues(
  client: GitHubApiClient,
  owner: string,
  repo: string,
  prNumber: number,
  prBody?: string,
): Promise<LinkedIssueSummary[]> {
  if (!prBody) return [];

  const pattern =
    /(?:(?:fix|fixes|fixed|close|closes|closed|resolve|resolves|resolved)\s+)?#(\d+)/gi;
  const nums = new Set<number>();
  for (const m of prBody.matchAll(pattern)) {
    const n = Number.parseInt(m[1] ?? "0", 10);
    if (n > 0 && n !== prNumber) nums.add(n);
  }

  if (nums.size === 0) return [];

  const limited = [...nums].slice(0, MAX_LINKED_ISSUES);
  const results = await Promise.allSettled(
    limited.map(async (num) => {
      const issue = await client.fetch<GitHubIssueResponse>(
        `/repos/${owner}/${repo}/issues/${num}`,
      );
      if (!issue) return null;

      const recent =
        (await client.fetch<GitHubIssueComment[]>(
          `/repos/${owner}/${repo}/issues/${num}/comments?per_page=${MAX_LINKED_ISSUE_COMMENTS}&direction=desc`,
        )) ?? [];

      return {
        number: num,
        title: issue.title ?? `Issue #${num}`,
        body: truncate(issue.body ?? "", 300),
        commentCount: issue.comments ?? 0,
        recentComments: recent
          .reverse()
          .filter((c) => !isNoiseBody(c.body))
          .map((c) => ({
            user: c.user?.login ?? "unknown",
            text: truncate(c.body ?? "", 200),
          })),
      } satisfies LinkedIssueSummary;
    }),
  );

  const summaries: LinkedIssueSummary[] = [];
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) {
      summaries.push(r.value);
    }
  }
  return summaries;
}

/* ---- Context formatting ------------------------------------------------ */

export function formatContextForPrompt(context: IntegrationContext): string {
  const gh = asGitHubContext(context);
  switch (gh.github?.contextType) {
    case "pr":
      return formatPrContext(gh);
    case "pr_review":
      return formatPrReviewContext(gh);
    case "discussion":
      return formatDiscussionContext(gh);
    default:
      return formatIssueContext(gh);
  }
}

function asGitHubContext(
  context: IntegrationContext,
): GitHubIntegrationContext {
  if ("github" in context) {
    return context as GitHubIntegrationContext;
  }
  return { ...context };
}

function formatIssueContext(ctx: GitHubIntegrationContext): string {
  const gh = ctx.github;
  const lines: string[] = [];

  lines.push(`# GitHub Issue #${gh?.number ?? "?"}`);
  lines.push("");
  if (gh?.title) {
    lines.push(`**Title:** ${gh.title}`);
  }
  if (ctx.messages[0]?.user) {
    lines.push(`**Author:** @${ctx.messages[0].user}`);
  }
  if (gh?.labels?.length) {
    lines.push(`**Labels:** ${gh.labels.join(", ")}`);
  }
  lines.push("");

  appendMessages(lines, "Issue & Comments", ctx.messages);
  appendCurrentRequest(lines, ctx);

  return lines.join("\n");
}

function formatPrContext(ctx: GitHubIntegrationContext): string {
  const gh = ctx.github;
  const lines: string[] = [];

  lines.push(`# GitHub PR #${gh?.number ?? "?"}`);
  lines.push("");
  if (gh?.title) {
    lines.push(`**Title:** ${gh.title}`);
  }
  if (ctx.messages[0]?.user) {
    lines.push(`**Author:** @${ctx.messages[0].user}`);
  }
  if (gh?.labels?.length) {
    lines.push(`**Labels:** ${gh.labels.join(", ")}`);
  }
  if (gh?.headBranch && gh.baseBranch) {
    lines.push(`**Branches:** \`${gh.headBranch}\` → \`${gh.baseBranch}\``);
  }
  if (gh?.changedFiles?.length) {
    const total = gh.changedFiles.length;
    const shown = gh.changedFiles.slice(0, MAX_CHANGED_FILES);
    lines.push(`**Changed files (${total}):**`);
    for (const file of shown) {
      lines.push(`- \`${file}\``);
    }
    if (total > MAX_CHANGED_FILES) {
      const extra = total - MAX_CHANGED_FILES;
      lines.push(`- _…and ${extra} more_`);
    }
  }
  lines.push("");

  if (gh?.linkedIssues?.length) {
    lines.push("## Linked Issues");
    lines.push("");
    for (const issue of gh.linkedIssues) {
      lines.push(
        `### #${issue.number} — ${issue.title} (${issue.commentCount} comments)`,
      );
      if (issue.body) {
        lines.push(`> ${issue.body}`);
      }
      if (issue.recentComments.length > 0) {
        lines.push("");
        lines.push("**Recent:**");
        for (const c of issue.recentComments) {
          lines.push(`> **@${c.user}:** ${c.text}`);
        }
      }
      lines.push("");
    }
  }

  appendMessages(lines, "Thread Messages", ctx.messages);
  appendCurrentRequest(lines, ctx);

  return lines.join("\n");
}

function formatPrReviewContext(ctx: GitHubIntegrationContext): string {
  const gh = ctx.github;
  const lines: string[] = [];

  lines.push("# GitHub PR Review Comment");
  lines.push("");
  if (gh?.title) {
    lines.push(`**PR:** #${gh.number} — ${gh.title}`);
  }
  if (gh?.path) {
    const lineInfo = gh.line ? ` (line ${gh.line})` : "";
    lines.push(`**File:** \`${gh.path}\`${lineInfo}`);
  }
  if (gh?.headBranch && gh.baseBranch) {
    lines.push(`**Branches:** \`${gh.headBranch}\` → \`${gh.baseBranch}\``);
  }
  lines.push("");

  if (gh?.diffHunk) {
    lines.push("## Diff Hunk");
    lines.push("");
    lines.push("```diff");
    lines.push(gh.diffHunk);
    lines.push("```");
    lines.push("");
  }

  appendMessages(lines, "Review Thread", ctx.messages);
  appendCurrentRequest(lines, ctx);

  return lines.join("\n");
}

function formatDiscussionContext(ctx: GitHubIntegrationContext): string {
  const gh = ctx.github;
  const lines: string[] = [];

  lines.push(`# GitHub Discussion #${gh?.number ?? "?"}`);
  lines.push("");
  if (gh?.title) {
    lines.push(`**Title:** ${gh.title}`);
  }
  if (ctx.messages[0]?.user) {
    lines.push(`**Author:** @${ctx.messages[0].user}`);
  }
  if (gh?.category) {
    lines.push(`**Category:** ${gh.category}`);
  }
  if (gh?.labels?.length) {
    lines.push(`**Labels:** ${gh.labels.join(", ")}`);
  }
  lines.push("");

  appendMessages(lines, "Discussion & Replies", ctx.messages);
  appendCurrentRequest(lines, ctx);

  return lines.join("\n");
}

/* ---- Helpers ----------------------------------------------------------- */

function appendMessages(
  lines: string[],
  heading: string,
  messages: IntegrationMessage[],
): void {
  if (messages.length === 0) return;
  lines.push(`## ${heading}`);
  lines.push("");
  for (const msg of messages) {
    lines.push(`**@${msg.user}:** ${msg.text}`);
    lines.push("");
  }
}

function appendCurrentRequest(
  lines: string[],
  ctx: GitHubIntegrationContext,
): void {
  lines.push("## Current Request");
  lines.push("");
  lines.push(`**From:** @${ctx.currentRequest.user}`);
  lines.push(`**Message:** ${ctx.currentRequest.text}`);
}

function extractLabelNames(labels?: { name?: string }[]): string[] {
  return (labels ?? [])
    .map((l) => l.name)
    .filter((name): name is string => !!name);
}

function toMessage(comment: GitHubIssueComment): IntegrationMessage {
  return {
    user: comment.user?.login ?? "unknown",
    text: comment.body ?? "",
    timestamp: comment.created_at,
  };
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}…`;
}
