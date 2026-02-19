import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { sessionTemplateService } from "../../container.ts";

export function registerSessionTemplateTools(server: McpServer): void {
  server.registerTool(
    "list_session_templates",
    {
      title: "List Session Templates",
      description:
        "List available session templates (AI workflows) for a workspace. " +
        "Templates define model, agent, prompt, and variant configurations " +
        "used when starting tasks. Returns merged global + workspace templates.",
      inputSchema: z.object({
        workspaceId: z
          .string()
          .optional()
          .describe(
            "Workspace ID to get merged templates for. " +
              "Returns global templates if omitted",
          ),
      }),
    },
    async ({ workspaceId }) => {
      const { templates, source } =
        sessionTemplateService.getMergedTemplates(workspaceId);

      const result = {
        source,
        templates: templates.map((t) => ({
          id: t.id,
          name: t.name,
          category: t.category,
          description: t.description ?? null,
          promptTemplate: t.promptTemplate ? "custom" : "default",
          defaultVariantIndex: t.defaultVariantIndex ?? 0,
          variants: t.variants.map((v) => ({
            name: v.name,
            model: `${v.model.providerID}/${v.model.modelID}`,
            agent: v.agent ?? null,
          })),
        })),
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
