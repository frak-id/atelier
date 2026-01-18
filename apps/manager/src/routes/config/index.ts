import { Elysia } from "elysia";
import {
  ConfigFileListQuerySchema,
  ConfigFileListResponseSchema,
  CreateConfigFileBodySchema,
  IdParamSchema,
  MergedConfigQuerySchema,
  MergedConfigResponseSchema,
  UpdateConfigFileBodySchema,
} from "../../schemas/index.ts";
import { ConfigFilesService } from "../../services/config-files.ts";

export const configRoutes = new Elysia({ prefix: "/config-files" })
  .get(
    "/",
    ({ query }) => {
      return ConfigFilesService.list({
        scope: query.scope,
        workspaceId: query.workspaceId,
      });
    },
    {
      query: ConfigFileListQuerySchema,
      response: ConfigFileListResponseSchema,
    },
  )
  .get(
    "/:id",
    ({ params, set }) => {
      const config = ConfigFilesService.getById(params.id);
      if (!config) {
        set.status = 404;
        return { error: "Config file not found" };
      }
      return config;
    },
    {
      params: IdParamSchema,
    },
  )
  .post(
    "/",
    ({ body, set }) => {
      try {
        return ConfigFilesService.create({
          path: body.path,
          content: body.content,
          contentType: body.contentType,
          scope: body.scope,
          workspaceId: body.workspaceId,
        });
      } catch (error) {
        set.status = 400;
        return {
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
    {
      body: CreateConfigFileBodySchema,
    },
  )
  .put(
    "/:id",
    ({ params, body, set }) => {
      try {
        const options: {
          content?: string;
          contentType?: "json" | "text" | "binary";
        } = {};
        if (body.content !== undefined) options.content = body.content;
        if (body.contentType !== undefined)
          options.contentType = body.contentType;
        return ConfigFilesService.update(params.id, options);
      } catch (error) {
        set.status = 404;
        return {
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
    {
      params: IdParamSchema,
      body: UpdateConfigFileBodySchema,
    },
  )
  .delete(
    "/:id",
    ({ params, set }) => {
      try {
        ConfigFilesService.delete(params.id);
        set.status = 204;
        return null;
      } catch (error) {
        set.status = 404;
        return {
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
    {
      params: IdParamSchema,
    },
  )
  .get(
    "/merged",
    ({ query }) => {
      return ConfigFilesService.getMergedForSandbox(query.workspaceId);
    },
    {
      query: MergedConfigQuerySchema,
      response: MergedConfigResponseSchema,
    },
  );
