import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import {
  agentClient,
  sandboxService,
  taskService,
  workspaceService,
} from "../../container.ts";

import { toolUrl } from "../../orchestrators/tools/registry.ts";
import {
  resolveDevConfig,
  type Sandbox,
  type Task,
} from "../../schemas/index.ts";

function findTaskForSandbox(sandboxId: string): Task | undefined {
  const allTasks = taskService.getAll();
  return allTasks.find((t) => t.data.sandboxId === sandboxId);
}

function formatSandbox(sandbox: Sandbox) {
  const workspace = sandbox.workspaceId
    ? workspaceService.getById(sandbox.workspaceId)
    : undefined;
  const task = findTaskForSandbox(sandbox.id);

  return {
    id: sandbox.id,
    status: sandbox.status,
    workspace: workspace
      ? { id: workspace.id, name: workspace.name }
      : sandbox.workspaceId
        ? { id: sandbox.workspaceId, name: "unknown" }
        : null,
    task: task
      ? {
          id: task.id,
          title: task.title,
          status: task.status,
          branchName: task.data.branchName ?? null,
        }
      : null,
    urls: sandbox.runtime.urls,
    resources: {
      vcpus: sandbox.runtime.vcpus,
      memoryMb: sandbox.runtime.memoryMb,
    },
    createdAt: sandbox.createdAt,
  };
}

export function registerSandboxTools(server: McpServer): void {
  server.registerTool(
    "list_sandboxes",
    {
      title: "List Sandboxes",
      description:
        "List sandboxes with optional filters. Returns sandbox details " +
        "including status, workspace, associated task, and URLs.",
      inputSchema: z.object({
        workspaceId: z.string().optional().describe("Filter by workspace ID"),
        status: z
          .enum(["creating", "running", "stopped", "error"])
          .optional()
          .describe("Filter by sandbox status"),
      }),
    },
    async ({ workspaceId, status }) => {
      let sandboxes: Sandbox[];
      if (workspaceId) {
        sandboxes = sandboxService.getByWorkspaceId(workspaceId);
      } else if (status) {
        sandboxes = sandboxService.getByStatus(status);
      } else {
        sandboxes = sandboxService.getAll();
      }

      if (status && workspaceId) {
        sandboxes = sandboxes.filter((s) => s.status === status);
      }

      const result = sandboxes.map(formatSandbox);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.registerTool(
    "get_sandbox",
    {
      title: "Get Sandbox",
      description:
        "Get detailed sandbox information including status, URLs, " +
        "associated task, and live dev command status with public URLs.",
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

      const base = formatSandbox(sandbox);

      const workspace = sandbox.workspaceId
        ? workspaceService.getById(sandbox.workspaceId)
        : undefined;
      const devConfig = resolveDevConfig(workspace?.config);
      let dev: unknown = null;
      if (devConfig) {
        let status = "stopped";
        if (sandbox.status === "running") {
          try {
            const s = await agentClient.serviceStatus(sandbox.id, "dev");
            status = s.running ? "running" : s.status;
          } catch {
            status = "unknown";
          }
        }
        dev = {
          command: devConfig.command,
          url: toolUrl("dev", sandbox.id),
          status,
        };
      }

      const result = { ...base, dev };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
