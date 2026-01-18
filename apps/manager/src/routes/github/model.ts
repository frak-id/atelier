import { t } from "elysia";

export const GitHubModel = {
  reposQuery: t.Object({
    page: t.Optional(t.Numeric({ minimum: 1 })),
    perPage: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })),
    affiliation: t.Optional(
      t.Union([
        t.Literal("owner"),
        t.Literal("collaborator"),
        t.Literal("organization_member"),
      ]),
    ),
    sort: t.Optional(
      t.Union([
        t.Literal("created"),
        t.Literal("updated"),
        t.Literal("pushed"),
        t.Literal("full_name"),
      ]),
    ),
  }),

  repository: t.Object({
    id: t.Number(),
    name: t.String(),
    fullName: t.String(),
    owner: t.Object({
      login: t.String(),
      avatarUrl: t.String(),
    }),
    private: t.Boolean(),
    htmlUrl: t.String(),
    cloneUrl: t.String(),
    sshUrl: t.String(),
    defaultBranch: t.String(),
    updatedAt: t.String(),
    description: t.Nullable(t.String()),
    language: t.Nullable(t.String()),
    stargazersCount: t.Number(),
    fork: t.Boolean(),
  }),

  reposResponse: t.Object({
    repositories: t.Array(
      t.Object({
        id: t.Number(),
        name: t.String(),
        fullName: t.String(),
        owner: t.Object({
          login: t.String(),
          avatarUrl: t.String(),
        }),
        private: t.Boolean(),
        htmlUrl: t.String(),
        cloneUrl: t.String(),
        sshUrl: t.String(),
        defaultBranch: t.String(),
        updatedAt: t.String(),
        description: t.Nullable(t.String()),
        language: t.Nullable(t.String()),
        stargazersCount: t.Number(),
        fork: t.Boolean(),
      }),
    ),
    pagination: t.Object({
      page: t.Number(),
      perPage: t.Number(),
      hasMore: t.Boolean(),
    }),
  }),
};
