import type {
  CreateConfigFileOptions,
  UpdateConfigFileOptions,
} from "@frak-sandbox/shared/types";
import { Elysia, t } from "elysia";
import { ConfigFilesService } from "../../services/config-files.ts";

export const configRoutes = new Elysia({ prefix: "/config-files" })
  .get(
    "/",
    ({ query }) => {
      return ConfigFilesService.list({
        scope: query.scope,
        projectId: query.projectId,
      });
    },
    {
      query: t.Object({
        scope: t.Optional(t.Union([t.Literal("global"), t.Literal("project")])),
        projectId: t.Optional(t.String()),
      }),
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
      params: t.Object({ id: t.String() }),
    },
  )
  .post(
    "/",
    ({ body, set }) => {
      try {
        const options: CreateConfigFileOptions = {
          path: body.path,
          content: body.content,
          contentType: body.contentType,
          scope: body.scope,
          projectId: body.projectId,
        };
        return ConfigFilesService.create(options);
      } catch (error) {
        set.status = 400;
        return {
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
    {
      body: t.Object({
        path: t.String(),
        content: t.String(),
        contentType: t.Union([
          t.Literal("json"),
          t.Literal("text"),
          t.Literal("binary"),
        ]),
        scope: t.Union([t.Literal("global"), t.Literal("project")]),
        projectId: t.Optional(t.String()),
      }),
    },
  )
  .put(
    "/:id",
    ({ params, body, set }) => {
      try {
        const options: UpdateConfigFileOptions = {};
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
      params: t.Object({ id: t.String() }),
      body: t.Object({
        content: t.Optional(t.String()),
        contentType: t.Optional(
          t.Union([t.Literal("json"), t.Literal("text"), t.Literal("binary")]),
        ),
      }),
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
      params: t.Object({ id: t.String() }),
    },
  )
  .get(
    "/merged",
    ({ query }) => {
      return ConfigFilesService.getMergedForSandbox(query.projectId);
    },
    {
      query: t.Object({
        projectId: t.Optional(t.String()),
      }),
    },
  );
