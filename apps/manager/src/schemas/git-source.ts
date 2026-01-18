import type { Static } from "elysia";
import { t } from "elysia";

export const GitSourceTypeSchema = t.Union([
  t.Literal("github"),
  t.Literal("gitlab"),
  t.Literal("custom"),
]);
export type GitSourceType = Static<typeof GitSourceTypeSchema>;

export const GitHubSourceConfigSchema = t.Object({
  accessToken: t.String(),
  userId: t.String(),
  username: t.String(),
  avatarUrl: t.Optional(t.String()),
});
export type GitHubSourceConfig = Static<typeof GitHubSourceConfigSchema>;

export const GitLabSourceConfigSchema = t.Object({
  accessToken: t.String(),
  baseUrl: t.Optional(t.String()),
  userId: t.String(),
  username: t.String(),
});
export type GitLabSourceConfig = Static<typeof GitLabSourceConfigSchema>;

export const CustomSourceConfigSchema = t.Object({
  baseUrl: t.String(),
  accessToken: t.Optional(t.String()),
});
export type CustomSourceConfig = Static<typeof CustomSourceConfigSchema>;

export const GitSourceConfigSchema = t.Union([
  GitHubSourceConfigSchema,
  GitLabSourceConfigSchema,
  CustomSourceConfigSchema,
]);
export type GitSourceConfig = Static<typeof GitSourceConfigSchema>;

export const GitSourceSchema = t.Object({
  id: t.String(),
  type: GitSourceTypeSchema,
  name: t.String(),
  config: GitSourceConfigSchema,
  createdAt: t.String(),
  updatedAt: t.String(),
});
export type GitSource = Static<typeof GitSourceSchema>;

export const CreateGitSourceBodySchema = t.Object({
  type: GitSourceTypeSchema,
  name: t.String({ minLength: 1, maxLength: 100 }),
  config: t.Record(t.String(), t.Unknown()),
});
export type CreateGitSourceBody = Static<typeof CreateGitSourceBodySchema>;

export const UpdateGitSourceBodySchema = t.Object({
  name: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
  config: t.Optional(t.Record(t.String(), t.Unknown())),
});
export type UpdateGitSourceBody = Static<typeof UpdateGitSourceBodySchema>;

export const GitSourceListResponseSchema = t.Array(GitSourceSchema);
export type GitSourceListResponse = Static<typeof GitSourceListResponseSchema>;

export const GitHubStatusResponseSchema = t.Union([
  t.Object({ connected: t.Literal(false) }),
  t.Object({
    connected: t.Literal(true),
    user: t.Object({
      login: t.String(),
      avatarUrl: t.Optional(t.String()),
    }),
  }),
]);
export type GitHubStatusResponse = Static<typeof GitHubStatusResponseSchema>;

export const GitHubRepoOwnerSchema = t.Object({
  login: t.String(),
  avatarUrl: t.String(),
});

export const GitHubRepoSchema = t.Object({
  id: t.Number(),
  name: t.String(),
  fullName: t.String(),
  owner: GitHubRepoOwnerSchema,
  private: t.Boolean(),
  htmlUrl: t.String(),
  cloneUrl: t.String(),
  sshUrl: t.String(),
  defaultBranch: t.String(),
  updatedAt: t.String(),
  description: t.Union([t.String(), t.Null()]),
  language: t.Union([t.String(), t.Null()]),
  stargazersCount: t.Number(),
  fork: t.Boolean(),
});
export type GitHubRepo = Static<typeof GitHubRepoSchema>;

export const GitHubReposResponseSchema = t.Object({
  repositories: t.Array(GitHubRepoSchema),
  pagination: t.Object({
    page: t.Number(),
    perPage: t.Number(),
    hasMore: t.Boolean(),
  }),
});
export type GitHubReposResponse = Static<typeof GitHubReposResponseSchema>;

export const GitHubReposQuerySchema = t.Object({
  page: t.Optional(t.String()),
  perPage: t.Optional(t.String()),
  affiliation: t.Optional(t.String()),
  sort: t.Optional(t.String()),
});
export type GitHubReposQuery = Static<typeof GitHubReposQuerySchema>;

export const SourceRepoSchema = t.Object({
  id: t.String(),
  fullName: t.String(),
  cloneUrl: t.String(),
  defaultBranch: t.String(),
  private: t.Boolean(),
});
export type SourceRepo = Static<typeof SourceRepoSchema>;

export const SourceReposResponseSchema = t.Array(SourceRepoSchema);
export type SourceReposResponse = Static<typeof SourceReposResponseSchema>;
