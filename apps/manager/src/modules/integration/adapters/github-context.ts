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
  GitHubLabel,
  GitHubPullFile,
  GitHubPullRequestResponse,
  GitHubPullReviewComment,
  GitHubRawEvent,
  LinkedIssueSummary,
} from "./github.types.ts";

const MAX_LINKED_ISSUES = 5;

/* ---- Context extraction ------------------------------------------------ */

export async function extractIssueContext(
  client: GitHubApiClient,
  event: IntegrationEvent,
  raw: GitHubRawEvent,
): Promise<GitHubIntegrationContext> {
  const [issue, comments] = await Promise.all([
    client.fetch<GitHubIssueResponse>(
      `/repos/${raw.owner}/${raw.repo}/issues/${raw.number}`,
    ),
    client
      .fetch<GitHubIssueComment[]>(
        `/repos/${raw.owner}/${raw.repo}/issues/${raw.number}/comments`,
      )
      .then((r) => r ?? []),
  ]);

  const labels = extractLabels(issue?.labels);

  const messages: IntegrationMessage[] = [];
  if (issue?.title || issue?.body) {
    const prefix = issue.title ? `${issue.title}\n\n` : "";
    messages.push({
      user: issue.user?.login ?? "unknown",
      text: `${prefix}${issue.body ?? ""}`.trim(),
    });
  }
  messages.push(...comments.map((c) => toMessage(c)));

  const triggering = comments.find((c) => c.id === raw.commentId);

  return {
    messages,
    currentRequest: {
      user: triggering?.user?.login ?? event.user,
      text: triggering?.body ?? event.text,
    },
    github: {
      contextType: "issue",
      number: raw.number,
      title: issue?.title,
      labels,
    },
  };
}

export async function extractPrContext(
  client: GitHubApiClient,
  event: IntegrationEvent,
  raw: GitHubRawEvent,
): Promise<GitHubIntegrationContext> {
  const [pr, issueComments, reviewComments, files] = await Promise.all([
    client.fetch<GitHubPullRequestResponse>(
      `/repos/${raw.owner}/${raw.repo}/pulls/${raw.number}`,
    ),
    client
      .fetch<GitHubIssueComment[]>(
        `/repos/${raw.owner}/${raw.repo}/issues/${raw.number}/comments`,
      )
      .then((r) => r ?? []),
    client
      .fetch<GitHubPullReviewComment[]>(
        `/repos/${raw.owner}/${raw.repo}/pulls/${raw.number}/comments`,
      )
      .then((r) => r ?? []),
    client
      .fetch<GitHubPullFile[]>(
        `/repos/${raw.owner}/${raw.repo}/pulls/${raw.number}/files`,
      )
      .then((r) => r ?? []),
  ]);

  const labels = extractLabels(pr?.labels);

  const messages: IntegrationMessage[] = [];
  if (pr?.title || pr?.body) {
    const prefix = pr.title ? `${pr.title}\n\n` : "";
    messages.push({
      user: pr.user?.login ?? "unknown",
      text: `${prefix}${pr.body ?? ""}`.trim(),
    });
  }

  const merged = [...issueComments, ...reviewComments].sort((a, b) => {
    const aTs = a.created_at ? Date.parse(a.created_at) : 0;
    const bTs = b.created_at ? Date.parse(b.created_at) : 0;
    return aTs - bTs;
  });
  messages.push(...merged.map((c) => toMessage(c)));

  const triggering = merged.find((c) => c.id === raw.commentId);

  const linkedIssues = await extractLinkedIssues(
    client,
    raw.owner,
    raw.repo,
    raw.number,
    pr?.body,
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
      title: pr?.title,
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
  const [comments, pr] = await Promise.all([
    client
      .fetch<GitHubPullReviewComment[]>(
        `/repos/${raw.owner}/${raw.repo}/pulls/${raw.number}/comments`,
      )
      .then((r) => r ?? []),
    client.fetch<GitHubPullRequestResponse>(
      `/repos/${raw.owner}/${raw.repo}/pulls/${raw.number}`,
    ),
  ]);

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

  const messages = threadComments.map((c) => toMessage(c));

  return {
    messages,
    currentRequest: {
      user: trigger?.user?.login ?? event.user,
      text: trigger?.body ?? event.text,
    },
    github: {
      contextType: "pr_review",
      number: raw.number,
      title: pr?.title,
      headBranch: raw.headBranch ?? pr?.head?.ref,
      baseBranch: raw.baseBranch ?? pr?.base?.ref,
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
    `query GetDiscussion(
        $owner: String!
        $repo: String!
        $number: Int!
      ) {
        repository(owner: $owner, name: $repo) {
          discussion(number: $number) {
            title
            body
            author { login }
            category { name }
            labels(first: 10) {
              nodes { name }
            }
            comments(first: 50) {
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

  const discussion = result?.repository?.discussion;
  const labels = (discussion?.labels?.nodes ?? [])
    .map((l) => l.name)
    .filter((name): name is string => !!name);

  const messages: IntegrationMessage[] = [];
  if (discussion?.title || discussion?.body) {
    const prefix = discussion.title ? `${discussion.title}\n\n` : "";
    messages.push({
      user: discussion.author?.login ?? "unknown",
      text: `${prefix}${discussion.body ?? ""}`.trim(),
    });
  }

  for (const node of discussion?.comments?.nodes ?? []) {
    messages.push({
      user: node.author?.login ?? "unknown",
      text: node.body ?? "",
      timestamp: node.createdAt,
    });
  }

  const triggering = (discussion?.comments?.nodes ?? []).find(
    (c) => c.databaseId === raw.commentId,
  );

  return {
    messages,
    currentRequest: {
      user: triggering?.author?.login ?? event.user,
      text: triggering?.body ?? event.text,
    },
    github: {
      contextType: "discussion",
      number: raw.number,
      title: discussion?.title,
      labels,
      category: discussion?.category?.name,
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

  // Match patterns: #123, fixes #123, closes #123, resolves #123
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
          `/repos/${owner}/${repo}/issues/${num}/comments?per_page=3&direction=desc`,
        )) ?? [];

      return {
        number: num,
        title: issue.title ?? `Issue #${num}`,
        body: truncate(issue.body ?? "", 300),
        commentCount: issue.comments ?? 0,
        recentComments: recent.reverse().map((c) => ({
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
    lines.push(`**Changed files:** ${gh.changedFiles.length}`);
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

function extractLabels(labels?: GitHubLabel[]): string[] {
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
