import { Elysia, t } from "elysia";
import { taskTemplateService } from "../../container.ts";
import {
  MergedTaskTemplatesResponseSchema,
  OpenCodeConfigResponseSchema,
  TaskTemplatesSchema,
  UpdateTaskTemplatesBodySchema,
} from "../../schemas/index.ts";

export const taskTemplateRoutes = new Elysia({ prefix: "/task-templates" })
  .get(
    "/global",
    () => {
      const { templates, isDefault } = taskTemplateService.getGlobalTemplates();
      return {
        templates,
        source: isDefault ? ("default" as const) : ("global" as const),
      };
    },
    {
      detail: {
        tags: ["task-templates"],
        summary: "Get global task templates",
      },
      response: MergedTaskTemplatesResponseSchema,
    },
  )
  .put(
    "/global",
    ({ body }) => {
      taskTemplateService.setGlobalTemplates(body.templates);
      const { templates } = taskTemplateService.getGlobalTemplates();
      return { templates, source: "global" as const };
    },
    {
      detail: {
        tags: ["task-templates"],
        summary: "Set global task templates",
      },
      body: UpdateTaskTemplatesBodySchema,
      response: MergedTaskTemplatesResponseSchema,
    },
  )
  .get(
    "/workspace/:workspaceId",
    ({ params }) => {
      const result = taskTemplateService.getMergedTemplates(params.workspaceId);
      return result;
    },
    {
      detail: {
        tags: ["task-templates"],
        summary: "Get merged task templates for a workspace",
      },
      params: t.Object({
        workspaceId: t.String(),
      }),
      response: MergedTaskTemplatesResponseSchema,
    },
  )
  .get(
    "/workspace/:workspaceId/override",
    ({ params }) => {
      const templates = taskTemplateService.getWorkspaceTemplates(
        params.workspaceId,
      );
      return { templates: templates ?? [] };
    },
    {
      detail: {
        tags: ["task-templates"],
        summary: "Get workspace-specific template overrides",
      },
      params: t.Object({
        workspaceId: t.String(),
      }),
      response: t.Object({ templates: TaskTemplatesSchema }),
    },
  )
  .get(
    "/workspace/:workspaceId/opencode-config",
    async ({ params }) => {
      return taskTemplateService.getOpenCodeConfig(params.workspaceId);
    },
    {
      detail: {
        tags: ["task-templates"],
        summary:
          "Get OpenCode configuration (providers, agents) from a running sandbox",
      },
      params: t.Object({
        workspaceId: t.String(),
      }),
      response: OpenCodeConfigResponseSchema,
    },
  );
