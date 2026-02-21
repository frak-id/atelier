import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import {
  sandboxService,
  systemAiService,
  taskService,
  taskSpawner,
  workspaceService,
} from "../../container.ts";
import type { Task } from "../../schemas/index.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";

const log = createChildLogger("mcp-task-tools");

function formatTask(task: Task) {
  const workspace = workspaceService.getById(task.workspaceId);
  const sandbox = task.data.sandboxId
    ? sandboxService.getById(task.data.sandboxId)
    : undefined;

  return {
    id: task.id,
    title: task.title,
    description: task.data.description,
    status: task.status,
    workspace: workspace
      ? { id: workspace.id, name: workspace.name }
      : { id: task.workspaceId, name: "unknown" },
    sandbox: sandbox
      ? { id: sandbox.id, status: sandbox.status }
      : task.data.sandboxId
        ? { id: task.data.sandboxId, status: "unknown" }
        : null,
    branchName: task.data.branchName ?? null,
    baseBranch: task.data.baseBranch ?? null,
    workflowId: task.data.workflowId ?? null,
    sessions: (task.data.sessions ?? []).map((s) => ({
      id: s.id,
      templateId: s.templateId,
      startedAt: s.startedAt ?? null,
    })),
    createdAt: task.createdAt,
    startedAt: task.data.startedAt ?? null,
    completedAt: task.data.completedAt ?? null,
  };
}

export function registerTaskTools(server: McpServer): void {
  server.registerTool(
    "list_tasks",
    {
      title: "List Tasks",
      description:
        "List tasks with optional filters. Returns task details " +
        "including status, workspace, sandbox info, and branch.",
      inputSchema: z.object({
        workspaceId: z.string().optional().describe("Filter by workspace ID"),
        status: z
          .enum(["draft", "active", "done"])
          .optional()
          .describe("Filter by task status"),
      }),
    },
    async ({ workspaceId, status }) => {
      let tasks: Task[];
      if (workspaceId) {
        tasks = taskService.getByWorkspaceId(workspaceId);
      } else {
        tasks = taskService.getAll();
      }

      if (status) {
        tasks = tasks.filter((t) => t.status === status);
      }

      const result = tasks.map(formatTask);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.registerTool(
    "get_task",
    {
      title: "Get Task",
      description:
        "Get detailed information about a specific task including " +
        "sessions, sandbox status, and branch info.",
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

      const result = formatTask(task);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.registerTool(
    "create_task",
    {
      title: "Create Task",
      description:
        "Create a new task for a workspace. Optionally auto-start it " +
        "which spawns a sandbox, creates a git branch, and launches " +
        "an OpenCode session with the task prompt.",
      inputSchema: z.object({
        workspaceId: z
          .string()
          .describe("The workspace ID to create the task in"),
        description: z
          .string()
          .describe("Task description / prompt for the AI"),
        title: z
          .string()
          .optional()
          .describe("Task title. Auto-generated from description if omitted"),
        baseBranch: z
          .string()
          .optional()
          .describe("Git base branch. Defaults to repo default branch"),
        workflowId: z
          .string()
          .optional()
          .describe(
            "Session template ID (e.g. 'implement', 'review'). " +
              "Defaults to 'implement'",
          ),
        variantIndex: z
          .number()
          .optional()
          .describe("Model variant index within the session template"),
        targetRepoIndices: z
          .array(z.number())
          .optional()
          .describe("Indices of repos to target. Defaults to all repos"),
        autoStart: z
          .boolean()
          .optional()
          .describe(
            "Start the task immediately after creation. " +
              "Spawns sandbox and launches AI session in background",
          ),
        integration: z
          .object({
            source: z.string(),
            threadKey: z.string(),
            raw: z.unknown().optional(),
          })
          .optional()
          .describe(
            "Integration metadata linking this task to an external " +
              "conversation (Slack thread, GitHub PR, etc.)",
          ),
      }),
    },
    async ({
      workspaceId,
      description,
      title,
      baseBranch,
      workflowId,
      variantIndex,
      targetRepoIndices,
      autoStart,
      integration,
    }) => {
      const workspace = workspaceService.getById(workspaceId);
      if (!workspace) {
        return {
          content: [
            {
              type: "text",
              text: `Workspace '${workspaceId}' not found`,
            },
          ],
          isError: true,
        };
      }

      const taskTitle =
        title?.trim() || systemAiService.fallbackTitle(description);

      const task = taskService.create({
        workspaceId,
        description,
        title: taskTitle,
        baseBranch,
        workflowId,
        variantIndex,
        targetRepoIndices,
      });

      if (integration) {
        const slackMeta =
          integration.source === "slack" && integration.raw
            ? {
                channel:
                  (integration.raw as { channel?: string }).channel ?? "",
                threadTs:
                  (integration.raw as { threadTs?: string }).threadTs ?? "",
              }
            : undefined;

        const githubMeta =
          integration.source === "github" && integration.raw
            ? {
                owner: (integration.raw as { owner?: string }).owner ?? "",
                repo: (integration.raw as { repo?: string }).repo ?? "",
                prNumber:
                  (integration.raw as { prNumber?: number }).prNumber ?? 0,
              }
            : undefined;

        taskService.setIntegrationMetadata(task.id, {
          source: integration.source,
          threadKey: integration.threadKey,
          ...(slackMeta && { slack: slackMeta }),
          ...(githubMeta && { github: githubMeta }),
        });
      }

      if (!title?.trim()) {
        systemAiService.generateTitleInBackground(
          description,
          (generatedTitle) => {
            taskService.updateTitle(task.id, generatedTitle);
            taskSpawner
              .updateSessionTitles(task.id, generatedTitle)
              .catch(() => {});
          },
        );
      }

      if (autoStart) {
        try {
          await taskService.startTask(task.id);
          taskSpawner.runInBackground(task.id);
          log.info({ taskId: task.id }, "Task auto-started via MCP");
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          const result = formatTask(taskService.getByIdOrThrow(task.id));
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    ...result,
                    autoStartError: msg,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
      }

      const result = formatTask(taskService.getByIdOrThrow(task.id));
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.registerTool(
    "complete_task",
    {
      title: "Complete Task",
      description: "Mark an active task as done.",
      inputSchema: z.object({
        taskId: z.string().describe("The task ID to complete"),
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

      if (task.status !== "active") {
        return {
          content: [
            {
              type: "text",
              text:
                `Task '${taskId}' is in '${task.status}' status. ` +
                "Only active tasks can be completed.",
            },
          ],
          isError: true,
        };
      }

      const updated = taskService.complete(taskId);
      const result = formatTask(updated);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
