import { Elysia } from "elysia";
import type { GitSourceConfig, GitSourceType } from "../../schemas/index.ts";
import {
  CreateGitSourceBodySchema,
  GitSourceListResponseSchema,
  GitSourceSchema,
  IdParamSchema,
  SourceReposResponseSchema,
  UpdateGitSourceBodySchema,
} from "../../schemas/index.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import { GitSourceService } from "./git-source.service.ts";

const log = createChildLogger("git-source-routes");

export const gitSourceRoutes = new Elysia({ prefix: "/sources" })
  .get(
    "/",
    () => {
      return GitSourceService.getAll();
    },
    {
      response: GitSourceListResponseSchema,
    },
  )
  .post(
    "/",
    async ({ body, set }) => {
      log.info({ type: body.type, name: body.name }, "Creating git source");
      const source = GitSourceService.create(
        body.type as GitSourceType,
        body.name,
        body.config as unknown as GitSourceConfig,
      );
      set.status = 201;
      return source;
    },
    {
      body: CreateGitSourceBodySchema,
      response: GitSourceSchema,
    },
  )
  .get(
    "/:id",
    ({ params }) => {
      return GitSourceService.getByIdOrThrow(params.id);
    },
    {
      params: IdParamSchema,
      response: GitSourceSchema,
    },
  )
  .put(
    "/:id",
    ({ params, body }) => {
      log.info({ sourceId: params.id }, "Updating git source");
      return GitSourceService.update(params.id, {
        name: body.name,
        config: body.config as unknown as GitSourceConfig,
      });
    },
    {
      params: IdParamSchema,
      body: UpdateGitSourceBodySchema,
      response: GitSourceSchema,
    },
  )
  .delete(
    "/:id",
    ({ params, set }) => {
      log.info({ sourceId: params.id }, "Deleting git source");
      GitSourceService.delete(params.id);
      set.status = 204;
      return null;
    },
    {
      params: IdParamSchema,
    },
  )
  .get(
    "/:id/repos",
    async ({ params }) => {
      return GitSourceService.fetchRepos(params.id);
    },
    {
      params: IdParamSchema,
      response: SourceReposResponseSchema,
    },
  );
