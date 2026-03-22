import type { IntegrationContext } from "../integration.types.ts";

/* ---- API client interface ---------------------------------------------- */

export interface GitHubApiClient {
  fetch<T>(path: string, init?: RequestInit): Promise<T | undefined>;
  graphql<T>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<T | undefined>;
}

/* ---- Internal types ---------------------------------------------------- */

export interface GitHubRawEvent {
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

export interface GitHubUser {
  login?: string;
}

export interface GitHubLabel {
  name?: string;
}

export interface GitHubIssueResponse {
  number: number;
  title?: string;
  body?: string;
  user?: GitHubUser;
  labels?: GitHubLabel[];
  comments?: number;
}

export interface GitHubPullRequestResponse {
  number: number;
  title?: string;
  body?: string;
  user?: GitHubUser;
  head?: { ref?: string };
  base?: { ref?: string };
  labels?: GitHubLabel[];
}

export interface GitHubIssueComment {
  id: number;
  body?: string;
  user?: GitHubUser;
  created_at?: string;
}

export interface GitHubPullReviewComment extends GitHubIssueComment {
  in_reply_to_id?: number;
  diff_hunk?: string;
  path?: string;
  line?: number;
}

export interface GitHubPullFile {
  filename?: string;
}

export interface GitHubCommentResponse {
  id?: number;
}

export interface GitHubReactionResponse {
  id?: number;
}

/* ---- GraphQL response types -------------------------------------------- */

export interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

export interface DiscussionQueryResult {
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

export interface AddDiscussionCommentResult {
  addDiscussionComment?: {
    comment?: {
      id?: string;
      databaseId?: number;
    };
  };
}

/* ---- Exported types ---------------------------------------------------- */

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
