import type { Static } from "elysia";
import { t } from "elysia";

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

export const GitHubBranchSchema = t.Object({
  name: t.String(),
  isDefault: t.Boolean(),
  lastCommitDate: t.Union([t.String(), t.Null()]),
});
export type GitHubBranch = Static<typeof GitHubBranchSchema>;

export const GitHubBranchesResponseSchema = t.Object({
  branches: t.Array(GitHubBranchSchema),
  defaultBranch: t.String(),
});
export type GitHubBranchesResponse = Static<
  typeof GitHubBranchesResponseSchema
>;

export const GitHubBranchesQuerySchema = t.Object({
  owner: t.String(),
  repo: t.String(),
});
export type GitHubBranchesQuery = Static<typeof GitHubBranchesQuerySchema>;
