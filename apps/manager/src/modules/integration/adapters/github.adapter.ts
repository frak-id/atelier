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

interface GitHubIssueResponse {
  number: number;
  title?: string;
  body?: string;
  user?: GitHubUser;
}

interface GitHubPullRequestResponse {
  number: number;
  title?: string;
  body?: string;
  user?: GitHubUser;
  head?: { ref?: string };
  base?: { ref?: string };
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

interface GitHubIntegrationContext extends IntegrationContext {
  github?: {
    contextType: GitHubRawEvent["contextType"];
    headBranch?: string;
    baseBranch?: string;
    changedFiles?: string[];
    diffHunk?: string;
    path?: string;
    line?: number;
  };
}

interface GitHubConfig {
  enabled: boolean;
  accessToken: string;
  webhookSecret: string;
}

export class GitHubAdapter implements IntegrationAdapter {
  readonly source = "github" as const;

  private cachedInstallationToken?: {
    token: string;
    expiresAt: number;
  };

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

  async extractContext(event: IntegrationEvent): Promise<IntegrationContext> {
    const raw = this.parseRawEvent(event);

    switch (raw.contextType) {
      case "issue":
        return this.extractIssueContext(event, raw);
      case "pr":
        return this.extractPrContext(event, raw);
      case "pr_review":
        return this.extractPrReviewContext(event, raw);
      default:
        return {
          messages: [],
          currentRequest: {
            user: event.user,
            text: event.text,
          },
          github: {
            contextType: "discussion",
          },
        } as GitHubIntegrationContext;
    }
  }

  formatContextForPrompt(context: IntegrationContext): string {
    const ghContext = this.asGitHubContext(context);

    let md = "# GitHub Context\n\n";

    if (ghContext.github?.contextType === "pr") {
      const head = ghContext.github.headBranch;
      const base = ghContext.github.baseBranch;
      if (head && base) {
        md += `**Branches:** \`${head}\` → \`${base}\`\n`;
      }
      if (ghContext.github.changedFiles) {
        md += `**Changed files:** ${ghContext.github.changedFiles.length}\n`;
      }
      md += "\n";
    }

    if (ghContext.github?.contextType === "pr_review") {
      const path = ghContext.github.path;
      const line = ghContext.github.line;
      if (path) {
        md += `**File:** \`${path}\`${line ? ` (line ${line})` : ""}\n\n`;
      }
      if (ghContext.github.diffHunk) {
        md += "## Diff Hunk\n\n";
        md += "```diff\n";
        md += `${ghContext.github.diffHunk}\n`;
        md += "```\n\n";
      }
    }

    if (context.messages.length > 0) {
      md += "## Thread Messages\n\n";
      for (const message of context.messages) {
        md += `**@${message.user}**: ${message.text}\n\n`;
      }
    }

    md += "## Current Request\n\n";
    md += `**From:** @${context.currentRequest.user}\n`;
    md += `**Message:** ${context.currentRequest.text}\n`;

    return md;
  }

  async addReaction(event: IntegrationEvent, emoji: string): Promise<void> {
    const raw = this.parseRawEvent(event);
    if (!raw.commentId) return;

    const content = mapReaction(emoji);

    try {
      await this.githubFetch(
        `/repos/${raw.owner}/${raw.repo}/issues/comments/${raw.commentId}/reactions`,
        {
          method: "POST",
          body: JSON.stringify({ content }),
        },
      );
    } catch (error) {
      log.debug({ error, emoji, content }, "Failed to add GitHub reaction");
    }
  }

  async removeReaction(event: IntegrationEvent, emoji: string): Promise<void> {
    const raw = this.parseRawEvent(event);

    log.debug(
      {
        owner: raw.owner,
        repo: raw.repo,
        number: raw.number,
        commentId: raw.commentId,
        emoji,
      },
      "GitHub reaction removal is no-op in v1",
    );
  }

  async postMessage(event: IntegrationEvent, text: string): Promise<void> {
    const raw = this.parseRawEvent(event);

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

    try {
      const response = await this.githubFetch<GitHubCommentResponse>(
        `/repos/${raw.owner}/${raw.repo}/issues/${raw.number}/comments`,
        {
          method: "POST",
          body: JSON.stringify({ body: renderProgressMarkdown(state) }),
        },
      );

      if (!response?.id) return undefined;
      return String(response.id);
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

    try {
      await this.githubFetch(
        `/repos/${raw.owner}/${raw.repo}/issues/comments/${messageId}`,
        {
          method: "PATCH",
          body: JSON.stringify({ body: renderProgressMarkdown(state) }),
        },
      );
    } catch (error) {
      log.debug({ error, messageId }, "Failed to update GitHub progress");
    }
  }

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

  private get githubConfig(): GitHubConfig {
    const integrations = config.integrations as typeof config.integrations & {
      github?: Partial<GitHubConfig>;
    };
    const github = integrations.github;

    return {
      enabled: github?.enabled ?? false,
      accessToken: github?.accessToken ?? "",
      webhookSecret: github?.webhookSecret ?? "",
    };
  }

  private async getInstallationToken(): Promise<string> {
    const now = Date.now();
    const cached = this.cachedInstallationToken;
    if (cached && cached.expiresAt > now + 30_000) {
      return cached.token;
    }

    const token = this.githubConfig.accessToken;
    this.cachedInstallationToken = {
      token,
      expiresAt: now + 60 * 60 * 1000,
    };

    return token;
  }

  private async githubFetch<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T | undefined> {
    const token = await this.getInstallationToken();
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

  private async extractIssueContext(
    event: IntegrationEvent,
    raw: GitHubRawEvent,
  ): Promise<GitHubIntegrationContext> {
    const issue = await this.githubFetch<GitHubIssueResponse>(
      `/repos/${raw.owner}/${raw.repo}/issues/${raw.number}`,
    );
    const comments =
      (await this.githubFetch<GitHubIssueComment[]>(
        `/repos/${raw.owner}/${raw.repo}/issues/${raw.number}/comments`,
      )) ?? [];

    const messages: IntegrationMessage[] = [];
    if (issue?.title || issue?.body) {
      const titlePrefix = issue.title ? `${issue.title}\n\n` : "";
      messages.push({
        user: issue.user?.login ?? "unknown",
        text: `${titlePrefix}${issue.body ?? ""}`.trim(),
      });
    }
    messages.push(...comments.map((comment) => toMessage(comment)));

    const triggering = comments.find((comment) => comment.id === raw.commentId);

    const context: GitHubIntegrationContext = {
      messages,
      currentRequest: {
        user: triggering?.user?.login ?? event.user,
        text: triggering?.body ?? event.text,
      },
      github: {
        contextType: "issue",
      },
    };

    return context;
  }

  private async extractPrContext(
    event: IntegrationEvent,
    raw: GitHubRawEvent,
  ): Promise<GitHubIntegrationContext> {
    const pr = await this.githubFetch<GitHubPullRequestResponse>(
      `/repos/${raw.owner}/${raw.repo}/pulls/${raw.number}`,
    );
    const issueComments =
      (await this.githubFetch<GitHubIssueComment[]>(
        `/repos/${raw.owner}/${raw.repo}/issues/${raw.number}/comments`,
      )) ?? [];
    const reviewComments =
      (await this.githubFetch<GitHubPullReviewComment[]>(
        `/repos/${raw.owner}/${raw.repo}/pulls/${raw.number}/comments`,
      )) ?? [];
    const changedFiles =
      (await this.githubFetch<GitHubPullFile[]>(
        `/repos/${raw.owner}/${raw.repo}/pulls/${raw.number}/files`,
      )) ?? [];

    const messages: IntegrationMessage[] = [];
    if (pr?.title || pr?.body) {
      const titlePrefix = pr.title ? `${pr.title}\n\n` : "";
      messages.push({
        user: pr.user?.login ?? "unknown",
        text: `${titlePrefix}${pr.body ?? ""}`.trim(),
      });
    }

    const mergedComments = [...issueComments, ...reviewComments].sort(
      (a, b) => {
        const aTs = a.created_at ? Date.parse(a.created_at) : 0;
        const bTs = b.created_at ? Date.parse(b.created_at) : 0;
        return aTs - bTs;
      },
    );
    messages.push(...mergedComments.map((comment) => toMessage(comment)));

    const triggering = mergedComments.find(
      (comment) => comment.id === raw.commentId,
    );

    const context: GitHubIntegrationContext = {
      messages,
      currentRequest: {
        user: triggering?.user?.login ?? event.user,
        text: triggering?.body ?? event.text,
      },
      github: {
        contextType: "pr",
        headBranch: raw.headBranch ?? pr?.head?.ref,
        baseBranch: raw.baseBranch ?? pr?.base?.ref,
        changedFiles: changedFiles
          .map((file) => file.filename)
          .filter((name): name is string => !!name),
      },
    };

    return context;
  }

  private async extractPrReviewContext(
    event: IntegrationEvent,
    raw: GitHubRawEvent,
  ): Promise<GitHubIntegrationContext> {
    const comments =
      (await this.githubFetch<GitHubPullReviewComment[]>(
        `/repos/${raw.owner}/${raw.repo}/pulls/${raw.number}/comments`,
      )) ?? [];

    const trigger = comments.find((comment) => comment.id === raw.commentId);
    const rootId = trigger?.in_reply_to_id ?? trigger?.id;

    const threadComments =
      rootId === undefined
        ? comments
        : comments.filter(
            (comment) =>
              comment.id === rootId || comment.in_reply_to_id === rootId,
          );

    threadComments.sort((a, b) => {
      const aTs = a.created_at ? Date.parse(a.created_at) : 0;
      const bTs = b.created_at ? Date.parse(b.created_at) : 0;
      return aTs - bTs;
    });

    const messages = threadComments.map((comment) => toMessage(comment));

    const context: GitHubIntegrationContext = {
      messages,
      currentRequest: {
        user: trigger?.user?.login ?? event.user,
        text: trigger?.body ?? event.text,
      },
      github: {
        contextType: "pr_review",
        diffHunk: raw.diffHunk ?? trigger?.diff_hunk,
        path: raw.path ?? trigger?.path,
        line: raw.line ?? trigger?.line,
      },
    };

    return context;
  }
}

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

function toMessage(comment: GitHubIssueComment): IntegrationMessage {
  return {
    user: comment.user?.login ?? "unknown",
    text: comment.body ?? "",
    timestamp: comment.created_at,
  };
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
      const statusSuffix =
        todo.status === "in_progress" ? " _(in progress)_" : "";
      lines.push(
        `- ${TODO_CHECKBOX[todo.status]} ${todo.content}${statusSuffix}`,
      );
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
