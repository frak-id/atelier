import { Elysia } from "elysia";
import { gitSourceService } from "../../container.ts";
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

const log = createChildLogger("git-source-routes");

export const gitSourceRoutes = new Elysia({ prefix: "/sources" })
  .get(
    "/",
    () => {
      return gitSourceService.getAll();
    },
    {
      response: GitSourceListResponseSchema,
    },
  )
  .post(
    "/",
    async ({ body, set }) => {
      log.info({ type: body.type, name: body.name }, "Creating git source");
      const source = gitSourceService.create(
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
      return gitSourceService.getByIdOrThrow(params.id);
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
      return gitSourceService.update(params.id, {
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
      gitSourceService.delete(params.id);
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
      return gitSourceService.fetchRepos(params.id);
    },
    {
      params: IdParamSchema,
      response: SourceReposResponseSchema,
    },
  );
