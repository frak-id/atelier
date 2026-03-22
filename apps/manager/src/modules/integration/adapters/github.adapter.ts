import type { TaskIntegrationMetadata } from "../../../schemas/task.ts";
import { config } from "../../../shared/lib/config.ts";
import { bytesToHex, timingSafeEqual } from "../../../shared/lib/crypto.ts";
import { createChildLogger } from "../../../shared/lib/logger.ts";
import type {
  IntegrationAdapter,
  IntegrationContext,
  IntegrationEvent,
  ProgressState,
} from "../integration.types.ts";
import type {
  AddDiscussionCommentResult,
  GitHubApiClient,
  GitHubCommentResponse,
  GitHubIntegrationContext,
  GitHubRawEvent,
  GitHubReactionResponse,
  GraphQLResponse,
} from "./github.types.ts";
import {
  extractDiscussionContext,
  extractIssueContext,
  extractPrContext,
  extractPrReviewContext,
  formatContextForPrompt,
} from "./github-context.ts";
import { renderProgressMarkdown } from "./github-progress.ts";

export type { GitHubIntegrationContext } from "./github.types.ts";

const log = createChildLogger("github-adapter");

const GITHUB_API_BASE = "https://api.github.com";

export class GitHubAdapter implements IntegrationAdapter {
  readonly source = "github" as const;

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

  /* ---- IntegrationAdapter — metadata ----------------------------------- */

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
    const client = this.apiClient;

    switch (raw.contextType) {
      case "issue":
        return extractIssueContext(client, event, raw);
      case "pr":
        return extractPrContext(client, event, raw);
      case "pr_review":
        return extractPrReviewContext(client, event, raw);
      case "discussion":
        return extractDiscussionContext(client, event, raw);
      default:
        return {
          messages: [],
          currentRequest: { user: event.user, text: event.text },
          github: { contextType: "issue" },
        };
    }
  }

  formatContextForPrompt(context: IntegrationContext): string {
    return formatContextForPrompt(context);
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

        await this.githubFetch(endpoint, { method: "DELETE" });
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
          { discussionId: raw.discussionNodeId, body },
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

  /* ---- Webhook verification -------------------------------------------- */

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

  private get apiClient(): GitHubApiClient {
    return {
      fetch: <T>(path: string, init?: RequestInit) =>
        this.githubFetch<T>(path, init),
      graphql: <T>(query: string, variables?: Record<string, unknown>) =>
        this.graphqlFetch<T>(query, variables),
    };
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
}

/* ---- Module-level helpers ---------------------------------------------- */

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
