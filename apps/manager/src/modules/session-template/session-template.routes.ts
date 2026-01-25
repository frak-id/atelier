import { Elysia, t } from "elysia";
import { sessionTemplateService } from "../../container.ts";
import {
  MergedSessionTemplatesResponseSchema,
  OpenCodeConfigResponseSchema,
  SessionTemplatesSchema,
  UpdateSessionTemplatesBodySchema,
} from "../../schemas/index.ts";

export const sessionTemplateRoutes = new Elysia({
  prefix: "/session-templates",
})
  .get(
    "/global",
    () => {
      const { templates, isDefault } =
        sessionTemplateService.getGlobalTemplates();
      return {
        templates,
        source: isDefault ? ("default" as const) : ("global" as const),
      };
    },
    {
      detail: {
        tags: ["session-templates"],
        summary: "Get global task templates",
      },
      response: MergedSessionTemplatesResponseSchema,
    },
  )
  .put(
    "/global",
    ({ body }) => {
      sessionTemplateService.setGlobalTemplates(body.templates);
      const { templates } = sessionTemplateService.getGlobalTemplates();
      return { templates, source: "global" as const };
    },
    {
      detail: {
        tags: ["session-templates"],
        summary: "Set global task templates",
      },
      body: UpdateSessionTemplatesBodySchema,
      response: MergedSessionTemplatesResponseSchema,
    },
  )
  .get(
    "/workspace/:workspaceId",
    ({ params }) => {
      const result = sessionTemplateService.getMergedTemplates(
        params.workspaceId,
      );
      return result;
    },
    {
      detail: {
        tags: ["session-templates"],
        summary: "Get merged task templates for a workspace",
      },
      params: t.Object({
        workspaceId: t.String(),
      }),
      response: MergedSessionTemplatesResponseSchema,
    },
  )
  .get(
    "/workspace/:workspaceId/override",
    ({ params }) => {
      const templates = sessionTemplateService.getWorkspaceTemplates(
        params.workspaceId,
      );
      return { templates: templates ?? [] };
    },
    {
      detail: {
        tags: ["session-templates"],
        summary: "Get workspace-specific template overrides",
      },
      params: t.Object({
        workspaceId: t.String(),
      }),
      response: t.Object({ templates: SessionTemplatesSchema }),
    },
  )
  .get(
    "/workspace/:workspaceId/opencode-config",
    async ({ params }) => {
      return sessionTemplateService.getOpenCodeConfig(params.workspaceId);
    },
    {
      detail: {
        tags: ["session-templates"],
        summary:
          "Get OpenCode configuration (providers, agents) from a running workspace sandbox",
      },
      params: t.Object({
        workspaceId: t.String(),
      }),
      response: OpenCodeConfigResponseSchema,
    },
  )
  .get(
    "/opencode-config",
    async () => {
      return sessionTemplateService.getOpenCodeConfigFromAnySandbox();
    },
    {
      detail: {
        tags: ["session-templates"],
        summary:
          "Get OpenCode configuration (providers, agents) from any running sandbox",
      },
      response: OpenCodeConfigResponseSchema,
    },
  );
