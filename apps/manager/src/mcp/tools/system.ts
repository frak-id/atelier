import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import {
  agentOperations,
  sandboxService,
  taskService,
  workspaceService,
} from "../../container.ts";
import { SYSTEM_WORKSPACE_ID } from "../../modules/system-sandbox/index.ts";
import { config } from "../../shared/lib/config.ts";

const startTime = Date.now();

export function registerSystemTools(server: McpServer): void {
  server.registerTool(
    "get_system_status",
    {
      title: "Get System Status",
      description:
        "Get system resource status: active sandbox count and max " +
        "sandbox limit. Use this to check resource availability " +
        "before spawning.",
      inputSchema: z.object({}),
    },
    async () => {
      const allRunning = sandboxService.getByStatus("running");
      const userRunning = allRunning.filter(
        (s) => s.workspaceId !== SYSTEM_WORKSPACE_ID,
      );
      const result = {
        activeSandboxes: userRunning.length,
        maxSandboxes: config.server.maxSandboxes,
        uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.registerTool(
    "get_sandbox_git_status",
    {
      title: "Get Sandbox Git Status",
      description:
        "Get git status for all repos in a sandbox. Returns branch, " +
        "dirty state, ahead/behind counts, and last commit for each repo.",
      inputSchema: z.object({
        sandboxId: z.string().describe("The sandbox ID"),
      }),
    },
    async ({ sandboxId }) => {
      const sandbox = sandboxService.getById(sandboxId);
      if (!sandbox) {
        return {
          content: [{ type: "text", text: `Sandbox '${sandboxId}' not found` }],
          isError: true,
        };
      }

      if (sandbox.status !== "running") {
        return {
          content: [
            {
              type: "text",
              text: `Sandbox '${sandboxId}' is not running`,
            },
          ],
          isError: true,
        };
      }

      const workspace = sandbox.workspaceId
        ? workspaceService.getById(sandbox.workspaceId)
        : undefined;
      const repos = workspace?.config.repos ?? [];

      if (repos.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { sandboxId, repos: [], message: "No repos configured" },
                null,
                2,
              ),
            },
          ],
        };
      }

      try {
        const gitStatus = await agentOperations.gitStatus(
          sandbox.id,
          repos.map((r) => ({ clonePath: r.clonePath })),
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { sandboxId, repos: gitStatus.repos },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Failed to get git status: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "get_task_sessions",
    {
      title: "Get Task Sessions",
      description:
        "Get OpenCode session details for a task. Returns session IDs, " +
        "template IDs, and start times. Useful for tracking AI progress.",
      inputSchema: z.object({
        taskId: z.string().describe("The task ID"),
      }),
    },
    async ({ taskId }) => {
      const task = taskService.getById(taskId);
      if (!task) {
        return {
          content: [{ type: "text", text: `Task '${taskId}' not found` }],
          isError: true,
        };
      }

      const sessions = (task.data.sessions ?? []).map((s) => ({
        id: s.id,
        templateId: s.templateId,
        order: s.order,
        startedAt: s.startedAt ?? null,
      }));

      const result = {
        taskId: task.id,
        title: task.title,
        status: task.status,
        sandboxId: task.data.sandboxId ?? null,
        sessions,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
