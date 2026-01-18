import { Elysia, t } from "elysia";
import { nanoid } from "nanoid";
import { NotFoundError } from "../../lib/errors.ts";
import { createChildLogger } from "../../lib/logger.ts";
import { GitSourceRepository } from "../../state/database.ts";
import type {
  GitSource,
  GitSourceConfig,
  GitSourceType,
} from "../../types/index.ts";

const log = createChildLogger("sources-route");

export const sourceRoutes = new Elysia({ prefix: "/sources" })
  .get("/", () => {
    return GitSourceRepository.getAll();
  })
  .post(
    "/",
    async ({ body, set }) => {
      const now = new Date().toISOString();
      const source: GitSource = {
        id: nanoid(12),
        type: body.type as GitSourceType,
        name: body.name,
        config: body.config as unknown as GitSourceConfig,
        createdAt: now,
        updatedAt: now,
      };

      log.info(
        { sourceId: source.id, type: source.type },
        "Creating git source",
      );
      GitSourceRepository.create(source);
      set.status = 201;
      return source;
    },
    {
      body: t.Object({
        type: t.Union([
          t.Literal("github"),
          t.Literal("gitlab"),
          t.Literal("custom"),
        ]),
        name: t.String({ minLength: 1, maxLength: 100 }),
        config: t.Record(t.String(), t.Unknown()),
      }),
    },
  )
  .get(
    "/:id",
    ({ params }) => {
      const source = GitSourceRepository.getById(params.id);
      if (!source) {
        throw new NotFoundError("GitSource", params.id);
      }
      return source;
    },
    {
      params: t.Object({ id: t.String() }),
    },
  )
  .put(
    "/:id",
    ({ params, body }) => {
      const existing = GitSourceRepository.getById(params.id);
      if (!existing) {
        throw new NotFoundError("GitSource", params.id);
      }

      log.info({ sourceId: params.id }, "Updating git source");

      const updates: Partial<GitSource> = {};
      if (body.name !== undefined) updates.name = body.name;
      if (body.config !== undefined)
        updates.config = body.config as unknown as GitSourceConfig;

      return GitSourceRepository.update(params.id, updates);
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        name: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
        config: t.Optional(t.Record(t.String(), t.Unknown())),
      }),
    },
  )
  .delete(
    "/:id",
    ({ params, set }) => {
      const existing = GitSourceRepository.getById(params.id);
      if (!existing) {
        throw new NotFoundError("GitSource", params.id);
      }

      log.info({ sourceId: params.id }, "Deleting git source");
      GitSourceRepository.delete(params.id);
      set.status = 204;
      return null;
    },
    {
      params: t.Object({ id: t.String() }),
    },
  )
  .get(
    "/:id/repos",
    async ({ params }) => {
      const source = GitSourceRepository.getById(params.id);
      if (!source) {
        throw new NotFoundError("GitSource", params.id);
      }

      if (source.type === "github") {
        const config = source.config as { accessToken: string };
        const response = await fetch(
          "https://api.github.com/user/repos?per_page=100&sort=updated",
          {
            headers: {
              Authorization: `Bearer ${config.accessToken}`,
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
            },
          },
        );

        if (!response.ok) {
          throw new Error(`GitHub API error: ${response.status}`);
        }

        interface GitHubRepo {
          id: number;
          full_name: string;
          clone_url: string;
          default_branch: string;
          private: boolean;
        }

        const repos = (await response.json()) as GitHubRepo[];
        return repos.map((repo) => ({
          id: String(repo.id),
          fullName: repo.full_name,
          cloneUrl: repo.clone_url,
          defaultBranch: repo.default_branch,
          private: repo.private,
        }));
      }

      return [];
    },
    {
      params: t.Object({ id: t.String() }),
    },
  );
