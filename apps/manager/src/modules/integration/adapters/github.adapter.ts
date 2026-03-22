import type { TaskIntegrationMetadata } from "../../../schemas/task.ts";
import { config } from "../../../shared/lib/config.ts";
import { createChildLogger } from "../../../shared/lib/logger.ts";
import type {
  IntegrationAdapter,
  IntegrationContext,
  IntegrationEvent,
  IntegrationMessage,
  ProgressState,
  TodoItem,
} from "../integration.types.ts";

const log = createChildLogger("github-adapter");

const GITHUB_API_BASE = "https://api.github.com";
const MAX_DISPLAY_TODOS = 15;
const MAX_LINKED_ISSUES = 5;

/* -------------------------------------------------------------------------- */
/*                              Internal types                                */
/* -------------------------------------------------------------------------- */

interface GitHubRawEvent {
  owner: string;
  repo: string;
  number: number;
  commentId: number;
  contextType: "issue" | "pr" | "pr_review" | "discussion";
  headBranch?: string;
  baseBranch?: string;
  diffHunk?: string;
  path?: string;
  line?: number;
  discussionNodeId?: string;
  commentNodeId?: string;
}

interface GitHubUser {
  login?: string;
}

interface GitHubLabel {
  name?: string;
}

interface GitHubIssueResponse {
  number: number;
  title?: string;
  body?: string;
  user?: GitHubUser;
  labels?: GitHubLabel[];
  comments?: number;
}

interface GitHubPullRequestResponse {
  number: number;
  title?: string;
  body?: string;
  user?: GitHubUser;
  head?: { ref?: string };
  base?: { ref?: string };
  labels?: GitHubLabel[];
}

interface GitHubIssueComment {
  id: number;
  body?: string;
  user?: GitHubUser;
  created_at?: string;
}

interface GitHubPullReviewComment extends GitHubIssueComment {
  in_reply_to_id?: number;
  diff_hunk?: string;
  path?: string;
  line?: number;
}

interface GitHubPullFile {
  filename?: string;
}

interface GitHubCommentResponse {
  id?: number;
}

interface GitHubReactionResponse {
  id?: number;
}

/* -------------------------------------------------------------------------- */
/*                              Exported types                                */
/* -------------------------------------------------------------------------- */

export interface LinkedIssueSummary {
  number: number;
  title: string;
  body: string;
  commentCount: number;
  recentComments: { user: string; text: string }[];
}

export interface GitHubIntegrationContext extends IntegrationContext {
  github?: {
    contextType: GitHubRawEvent["contextType"];
    number?: number;
    title?: string;
    labels?: string[];
    headBranch?: string;
    baseBranch?: string;
    changedFiles?: string[];
    linkedIssues?: LinkedIssueSummary[];
    diffHunk?: string;
    path?: string;
    line?: number;
    category?: string;
  };
}

/* -------------------------------------------------------------------------- */
/*                          GraphQL response types                            */
/* -------------------------------------------------------------------------- */

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

interface DiscussionQueryResult {
  repository?: {
    discussion?: {
      title?: string;
      body?: string;
      author?: { login?: string };
      category?: { name?: string };
      labels?: { nodes?: { name?: string }[] };
      comments?: {
        nodes?: {
          id?: string;
          databaseId?: number;
          body?: string;
          author?: { login?: string };
          createdAt?: string;
        }[];
      };
    };
  };
}

interface AddDiscussionCommentResult {
  addDiscussionComment?: {
    comment?: {
      id?: string;
      databaseId?: number;
    };
  };
}

/* -------------------------------------------------------------------------- */
/*                               Adapter class                                */
/* -------------------------------------------------------------------------- */

export class GitHubAdapter implements IntegrationAdapter {
  readonly source = "github" as const;

  /**
   * In-memory cache: (commentKey:emoji) → reaction ID.
   *
   * TODO: Persist reaction IDs to the database so they survive
   * manager restarts. For v1 the in-memory cache is acceptable
   * because reactions are cosmetic feedback, not critical state.
   */
  private reactionCache = new Map<string, number | string>();

  /* ---- Static helpers -------------------------------------------------- */

  static buildThreadKey(
    owner: string,
    repo: string,
    number: number,
    type: "issue" | "pr" | "pr_review" | "discussion" = "issue",
  ): string {
    const marker = type === "discussion" ? "!" : "#";
    return `${owner}/${repo}${marker}${number}`;
  }

  static parseThreadKey(threadKey: string): {
    owner: string;
    repo: string;
    number: number;
    type: "issue" | "pr" | "pr_review" | "discussion";
  } {
    const discussionIdx = threadKey.lastIndexOf("!");
    const issueIdx = threadKey.lastIndexOf("#");
    const markerIdx = Math.max(discussionIdx, issueIdx);
    const marker = markerIdx >= 0 ? threadKey[markerIdx] : "#";

    const repoPath = markerIdx >= 0 ? threadKey.slice(0, markerIdx) : threadKey;
    const numberPart = markerIdx >= 0 ? threadKey.slice(markerIdx + 1) : "0";

    const slashIdx = repoPath.indexOf("/");
    const owner = slashIdx >= 0 ? repoPath.slice(0, slashIdx) : repoPath;
    const repo = slashIdx >= 0 ? repoPath.slice(slashIdx + 1) : "";

    return {
      owner,
      repo,
      number: Number.parseInt(numberPart, 10) || 0,
      type: marker === "!" ? "discussion" : "issue",
    };
  }

  /* ---- IntegrationAdapter — metadata ------------------------------------ */

  buildTaskMetadata(event: IntegrationEvent): TaskIntegrationMetadata {
    const raw = this.parseRawEvent(event);
    const metadata: TaskIntegrationMetadata = {
      source: event.source,
      threadKey: event.threadKey,
      github: {
        owner: raw.owner,
        repo: raw.repo,
        number: raw.number,
        contextType: raw.contextType,
        commentId: raw.commentId || undefined,
      },
    };

    if (raw.owner && raw.repo && raw.number) {
      const urlType =
        raw.contextType === "discussion"
          ? "discussions"
          : raw.contextType === "pr" || raw.contextType === "pr_review"
            ? "pull"
            : "issues";
      metadata.externalUrl = `https://github.com/${raw.owner}/${raw.repo}/${urlType}/${raw.number}`;
    }

    return metadata;
  }

  /* ---- IntegrationAdapter — context ------------------------------------ */

  async extractContext(
    event: IntegrationEvent,
  ): Promise<GitHubIntegrationContext> {
    const raw = this.parseRawEvent(event);

    switch (raw.contextType) {
      case "issue":
        return this.extractIssueContext(event, raw);
      case "pr":
        return this.extractPrContext(event, raw);
      case "pr_review":
        return this.extractPrReviewContext(event, raw);
      case "discussion":
        return this.extractDiscussionContext(event, raw);
      default:
        return {
          messages: [],
          currentRequest: {
            user: event.user,
            text: event.text,
          },
          github: { contextType: "issue" },
        };
    }
  }

  formatContextForPrompt(context: IntegrationContext): string {
    const gh = this.asGitHubContext(context);
    switch (gh.github?.contextType) {
      case "pr":
        return this.formatPrContext(gh);
      case "pr_review":
        return this.formatPrReviewContext(gh);
      case "discussion":
        return this.formatDiscussionContext(gh);
      default:
        return this.formatIssueContext(gh);
    }
  }

  /* ---- IntegrationAdapter — reactions ---------------------------------- */

  async addReaction(event: IntegrationEvent, emoji: string): Promise<void> {
    const raw = this.parseRawEvent(event);
    if (!raw.commentId && !raw.commentNodeId) return;

    const content = mapReaction(emoji);

    try {
      if (raw.contextType === "discussion" && raw.commentNodeId) {
        const result = await this.graphqlFetch<{
          addReaction?: {
            reaction?: { id?: string };
          };
        }>(
          `mutation AddReaction(
            $subjectId: ID!
            $content: ReactionContent!
          ) {
            addReaction(
              input: {
                subjectId: $subjectId
                content: $content
              }
            ) { reaction { id } }
          }`,
          {
            subjectId: raw.commentNodeId,
            content: graphqlReactionContent(content),
          },
        );
        const rid = result?.addReaction?.reaction?.id;
        if (rid) {
          this.reactionCache.set(reactionCacheKey(raw, emoji), rid);
        }
      } else {
        const endpoint =
          raw.contextType === "pr_review"
            ? `/repos/${raw.owner}/${raw.repo}/pulls/comments/${raw.commentId}/reactions`
            : `/repos/${raw.owner}/${raw.repo}/issues/comments/${raw.commentId}/reactions`;

        const resp = await this.githubFetch<GitHubReactionResponse>(endpoint, {
          method: "POST",
          body: JSON.stringify({ content }),
        });
        if (resp?.id) {
          this.reactionCache.set(reactionCacheKey(raw, emoji), resp.id);
        }
      }
    } catch (error) {
      log.debug({ error, emoji, content }, "Failed to add GitHub reaction");
    }
  }

  async removeReaction(event: IntegrationEvent, emoji: string): Promise<void> {
    const raw = this.parseRawEvent(event);
    const cacheKey = reactionCacheKey(raw, emoji);
    const reactionId = this.reactionCache.get(cacheKey);

    if (!reactionId) {
      log.debug({ emoji, cacheKey }, "No cached reaction ID to remove");
      return;
    }

    try {
      if (
        raw.contextType === "discussion" &&
        raw.commentNodeId &&
        typeof reactionId === "string"
      ) {
        await this.graphqlFetch(
          `mutation RemoveReaction(
            $subjectId: ID!
            $content: ReactionContent!
          ) {
            removeReaction(
              input: {
                subjectId: $subjectId
                content: $content
              }
            ) { reaction { id } }
          }`,
          {
            subjectId: raw.commentNodeId,
            content: graphqlReactionContent(mapReaction(emoji)),
          },
        );
      } else if (typeof reactionId === "number") {
        const endpoint =
          raw.contextType === "pr_review"
            ? `/repos/${raw.owner}/${raw.repo}/pulls/comments/${raw.commentId}/reactions/${reactionId}`
            : `/repos/${raw.owner}/${raw.repo}/issues/comments/${raw.commentId}/reactions/${reactionId}`;

        await this.githubFetch(endpoint, {
          method: "DELETE",
        });
      }

      this.reactionCache.delete(cacheKey);
    } catch (error) {
      log.debug({ error, emoji }, "Failed to remove GitHub reaction");
    }
  }

  /* ---- IntegrationAdapter — messaging ---------------------------------- */

  async postMessage(event: IntegrationEvent, text: string): Promise<void> {
    const raw = this.parseRawEvent(event);

    if (raw.contextType === "discussion" && raw.discussionNodeId) {
      await this.graphqlFetch<AddDiscussionCommentResult>(
        `mutation AddComment(
          $discussionId: ID!
          $body: String!
        ) {
          addDiscussionComment(
            input: {
              discussionId: $discussionId
              body: $body
            }
          ) { comment { id } }
        }`,
        { discussionId: raw.discussionNodeId, body: text },
      );
      return;
    }

    await this.githubFetch(
      `/repos/${raw.owner}/${raw.repo}/issues/${raw.number}/comments`,
      {
        method: "POST",
        body: JSON.stringify({ body: text }),
      },
    );
  }

  async postProgressMessage(
    event: IntegrationEvent,
    state: ProgressState,
  ): Promise<string | undefined> {
    const raw = this.parseRawEvent(event);
    const body = renderProgressMarkdown(state);

    try {
      if (raw.contextType === "discussion" && raw.discussionNodeId) {
        const result = await this.graphqlFetch<AddDiscussionCommentResult>(
          `mutation AddComment(
              $discussionId: ID!
              $body: String!
            ) {
              addDiscussionComment(
                input: {
                  discussionId: $discussionId
                  body: $body
                }
              ) { comment { id databaseId } }
            }`,
          {
            discussionId: raw.discussionNodeId,
            body,
          },
        );
        return result?.addDiscussionComment?.comment?.id ?? undefined;
      }

      const resp = await this.githubFetch<GitHubCommentResponse>(
        `/repos/${raw.owner}/${raw.repo}/issues/${raw.number}/comments`,
        {
          method: "POST",
          body: JSON.stringify({ body }),
        },
      );
      if (!resp?.id) return undefined;
      return String(resp.id);
    } catch (error) {
      log.debug({ error }, "Failed to post GitHub progress message");
      return undefined;
    }
  }

  async updateProgressMessage(
    event: IntegrationEvent,
    messageId: string,
    state: ProgressState,
  ): Promise<void> {
    const raw = this.parseRawEvent(event);
    const body = renderProgressMarkdown(state);

    try {
      const isGraphQLId = messageId.length > 0 && !/^\d+$/.test(messageId);

      if (isGraphQLId) {
        await this.graphqlFetch(
          `mutation UpdateComment(
            $commentId: ID!
            $body: String!
          ) {
            updateDiscussionComment(
              input: {
                commentId: $commentId
                body: $body
              }
            ) { comment { id } }
          }`,
          { commentId: messageId, body },
        );
      } else {
        await this.githubFetch(
          `/repos/${raw.owner}/${raw.repo}/issues/comments/${messageId}`,
          {
            method: "PATCH",
            body: JSON.stringify({ body }),
          },
        );
      }
    } catch (error) {
      log.debug({ error, messageId }, "Failed to update GitHub progress");
    }
  }

  /* ---- IntegrationAdapter — webhook verification ----------------------- */

  async verifyWebhook(signature: string, payload: string): Promise<boolean> {
    const webhookSecret = this.githubConfig.webhookSecret;
    if (!webhookSecret || !signature) return false;

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(webhookSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );

    const digest = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(payload),
    );

    const computedHex = bytesToHex(new Uint8Array(digest));
    const computedSignature = `sha256=${computedHex}`;

    return timingSafeEqual(computedSignature, signature);
  }

  /* ---- Private: config ------------------------------------------------- */

  private get githubConfig() {
    return config.integrations.github;
  }

  /* ---- Private: HTTP --------------------------------------------------- */

  private async githubFetch<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T | undefined> {
    const token = this.githubConfig.accessToken;
    if (!token) {
      log.warn({ path }, "GitHub access token missing");
      return undefined;
    }

    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("Accept", "application/vnd.github+json");
    headers.set("X-GitHub-Api-Version", "2022-11-28");
    if (init.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const response = await fetch(`${GITHUB_API_BASE}${path}`, {
      ...init,
      headers,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      log.warn(
        {
          path,
          method: init.method ?? "GET",
          status: response.status,
          body: errorBody,
        },
        "GitHub API request failed",
      );
      return undefined;
    }

    if (response.status === 204) {
      return undefined;
    }

    return (await response.json()) as T;
  }

  private async graphqlFetch<T>(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T | undefined> {
    const token = this.githubConfig.accessToken;
    if (!token) {
      log.warn("GitHub access token missing for GraphQL");
      return undefined;
    }

    const response = await fetch(`${GITHUB_API_BASE}/graphql`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      log.warn(
        { status: response.status, body: errorBody },
        "GitHub GraphQL request failed",
      );
      return undefined;
    }

    const result = (await response.json()) as GraphQLResponse<T>;
    if (result.errors?.length) {
      log.warn({ errors: result.errors }, "GitHub GraphQL errors");
    }
    return result.data;
  }

  /* ---- Private: parsing ------------------------------------------------ */

  private parseRawEvent(event: IntegrationEvent): GitHubRawEvent {
    const raw = event.raw as Partial<GitHubRawEvent>;
    const parsedThread = GitHubAdapter.parseThreadKey(event.threadKey);

    const owner = raw.owner ?? parsedThread.owner;
    const repo = raw.repo ?? parsedThread.repo;
    const number = raw.number ?? parsedThread.number;

    return {
      owner,
      repo,
      number,
      commentId: raw.commentId ?? 0,
      contextType: raw.contextType ?? parsedThread.type,
      headBranch: raw.headBranch,
      baseBranch: raw.baseBranch,
      diffHunk: raw.diffHunk,
      path: raw.path,
      line: raw.line,
      discussionNodeId: raw.discussionNodeId,
      commentNodeId: raw.commentNodeId,
    };
  }

  private asGitHubContext(
    context: IntegrationContext,
  ): GitHubIntegrationContext {
    if ("github" in context) {
      return context as GitHubIntegrationContext;
    }
    return { ...context };
  }

  /* ---- Private: context extraction ------------------------------------- */

  private async extractIssueContext(
    event: IntegrationEvent,
    raw: GitHubRawEvent,
  ): Promise<GitHubIntegrationContext> {
    const [issue, comments] = await Promise.all([
      this.githubFetch<GitHubIssueResponse>(
        `/repos/${raw.owner}/${raw.repo}/issues/${raw.number}`,
      ),
      this.githubFetch<GitHubIssueComment[]>(
        `/repos/${raw.owner}/${raw.repo}/issues/${raw.number}/comments`,
      ).then((r) => r ?? []),
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

  private async extractPrContext(
    event: IntegrationEvent,
    raw: GitHubRawEvent,
  ): Promise<GitHubIntegrationContext> {
    const [pr, issueComments, reviewComments, files] = await Promise.all([
      this.githubFetch<GitHubPullRequestResponse>(
        `/repos/${raw.owner}/${raw.repo}/pulls/${raw.number}`,
      ),
      this.githubFetch<GitHubIssueComment[]>(
        `/repos/${raw.owner}/${raw.repo}/issues/${raw.number}/comments`,
      ).then((r) => r ?? []),
      this.githubFetch<GitHubPullReviewComment[]>(
        `/repos/${raw.owner}/${raw.repo}/pulls/${raw.number}/comments`,
      ).then((r) => r ?? []),
      this.githubFetch<GitHubPullFile[]>(
        `/repos/${raw.owner}/${raw.repo}/pulls/${raw.number}/files`,
      ).then((r) => r ?? []),
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

    const linkedIssues = await this.extractLinkedIssues(
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

  private async extractPrReviewContext(
    event: IntegrationEvent,
    raw: GitHubRawEvent,
  ): Promise<GitHubIntegrationContext> {
    const [comments, pr] = await Promise.all([
      this.githubFetch<GitHubPullReviewComment[]>(
        `/repos/${raw.owner}/${raw.repo}/pulls/${raw.number}/comments`,
      ).then((r) => r ?? []),
      this.githubFetch<GitHubPullRequestResponse>(
        `/repos/${raw.owner}/${raw.repo}/pulls/${raw.number}`,
      ),
    ]);

    const trigger = comments.find((c) => c.id === raw.commentId);
    const rootId = trigger?.in_reply_to_id ?? trigger?.id;

    const threadComments =
      rootId === undefined
        ? comments
        : comments.filter(
            (c) => c.id === rootId || c.in_reply_to_id === rootId,
          );

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

  private async extractDiscussionContext(
    event: IntegrationEvent,
    raw: GitHubRawEvent,
  ): Promise<GitHubIntegrationContext> {
    const result = await this.graphqlFetch<DiscussionQueryResult>(
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

  private async extractLinkedIssues(
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
        const issue = await this.githubFetch<GitHubIssueResponse>(
          `/repos/${owner}/${repo}/issues/${num}`,
        );
        if (!issue) return null;

        const recent =
          (await this.githubFetch<GitHubIssueComment[]>(
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

  /* ---- Private: context formatting ------------------------------------- */

  private formatIssueContext(ctx: GitHubIntegrationContext): string {
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

    this.appendMessages(lines, "Issue & Comments", ctx.messages);
    this.appendCurrentRequest(lines, ctx);

    return lines.join("\n");
  }

  private formatPrContext(ctx: GitHubIntegrationContext): string {
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

    this.appendMessages(lines, "Thread Messages", ctx.messages);
    this.appendCurrentRequest(lines, ctx);

    return lines.join("\n");
  }

  private formatPrReviewContext(ctx: GitHubIntegrationContext): string {
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

    this.appendMessages(lines, "Review Thread", ctx.messages);
    this.appendCurrentRequest(lines, ctx);

    return lines.join("\n");
  }

  private formatDiscussionContext(ctx: GitHubIntegrationContext): string {
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

    this.appendMessages(lines, "Discussion & Replies", ctx.messages);
    this.appendCurrentRequest(lines, ctx);

    return lines.join("\n");
  }

  private appendMessages(
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

  private appendCurrentRequest(
    lines: string[],
    ctx: GitHubIntegrationContext,
  ): void {
    lines.push("## Current Request");
    lines.push("");
    lines.push(`**From:** @${ctx.currentRequest.user}`);
    lines.push(`**Message:** ${ctx.currentRequest.text}`);
  }
}

/* -------------------------------------------------------------------------- */
/*                            Module-level helpers                            */
/* -------------------------------------------------------------------------- */

const TODO_CHECKBOX: Record<TodoItem["status"], string> = {
  completed: "[x]",
  in_progress: "[ ]",
  pending: "[ ]",
  cancelled: "[ ]",
};

function mapReaction(emoji: string): string {
  const normalized = emoji.replaceAll(":", "");
  const map: Record<string, string> = {
    hourglass_flowing_sand: "eyes",
    brain: "rocket",
    warning: "eyes",
  };
  return map[normalized] ?? "eyes";
}

function graphqlReactionContent(restContent: string): string {
  const map: Record<string, string> = {
    "+1": "THUMBS_UP",
    "-1": "THUMBS_DOWN",
    laugh: "LAUGH",
    confused: "CONFUSED",
    heart: "HEART",
    hooray: "HOORAY",
    rocket: "ROCKET",
    eyes: "EYES",
  };
  return map[restContent] ?? "EYES";
}

function reactionCacheKey(raw: GitHubRawEvent, emoji: string): string {
  const id = raw.commentNodeId ?? String(raw.commentId);
  return `${id}:${emoji}`;
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

function renderProgressMarkdown(state: ProgressState): string {
  const lines: string[] = [];

  lines.push("<!-- atelier-progress -->");
  lines.push("");
  lines.push(progressHeader(state));
  lines.push("");
  lines.push(
    `[:computer: Dashboard](${state.urls.dashboard}) · [:brain: OpenCode](${state.urls.opencode})`,
  );

  if (state.attention) {
    const icon =
      state.attention.type === "permission" ? ":raised_hand:" : ":question:";
    lines.push("");
    lines.push("## Attention Required");
    lines.push(
      `${icon} ${state.attention.description} — [Answer in Dashboard](${state.attention.url})`,
    );
  }

  const activeTodos = state.todos.filter((todo) => todo.status !== "cancelled");
  if (activeTodos.length > 0) {
    const completed = activeTodos.filter(
      (todo) => todo.status === "completed",
    ).length;

    lines.push("");
    lines.push(`## Progress (${completed}/${activeTodos.length})`);

    const visible = activeTodos.slice(0, MAX_DISPLAY_TODOS);
    for (const todo of visible) {
      const suffix = todo.status === "in_progress" ? " _(in progress)_" : "";
      lines.push(`- ${TODO_CHECKBOX[todo.status]} ${todo.content}${suffix}`);
    }

    if (activeTodos.length > MAX_DISPLAY_TODOS) {
      lines.push(`- [ ] …and ${activeTodos.length - MAX_DISPLAY_TODOS} more`);
    }
  }

  return lines.join("\n");
}

function progressHeader(state: ProgressState): string {
  switch (state.status) {
    case "completed": {
      const dur = state.duration ? ` — ${state.duration}` : "";
      return `:white_check_mark: **Agent finished**${dur}`;
    }
    case "attention":
      return ":warning: **Agent needs input**";
    case "running":
      return ":hourglass_flowing_sand: **Agent working**";
    default:
      return ":rocket: **Agent started**";
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);

  if (aBytes.length !== bBytes.length) {
    return false;
  }

  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }

  return diff === 0;
}
