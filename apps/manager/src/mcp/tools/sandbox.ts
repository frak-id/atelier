import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import {
  agentClient,
  sandboxService,
  taskService,
  workspaceService,
} from "../../container.ts";

import type { Sandbox, Task } from "../../schemas/index.ts";
import { config } from "../../shared/lib/config.ts";

function findTaskForSandbox(sandboxId: string): Task | undefined {
  const allTasks = taskService.getAll();
  return allTasks.find((t) => t.data.sandboxId === sandboxId);
}

function buildDevUrl(sandboxId: string, cmdName: string): string {
  return `https://dev-${cmdName}-${sandboxId}.${config.domain.dashboard}`;
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
        "including status, workspace, associated task, and URLs. " +
        "System sandboxes are excluded by default.",
      inputSchema: z.object({
        workspaceId: z.string().optional().describe("Filter by workspace ID"),
        status: z
          .enum(["creating", "running", "stopped", "error"])
          .optional()
          .describe("Filter by sandbox status"),
        includeSystem: z
          .boolean()
          .optional()
          .describe("Include system sandboxes. Defaults to false"),
      }),
    },
    async ({ workspaceId, status, includeSystem }) => {
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

      if (!includeSystem) {
        sandboxes = sandboxes.filter((s) => s.origin?.source !== "system");
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

      // Fetch live dev command status if sandbox is running
      let devCommands: unknown[] = [];
      if (sandbox.status === "running") {
        const workspace = sandbox.workspaceId
          ? workspaceService.getById(sandbox.workspaceId)
          : undefined;
        const configuredCommands = workspace?.config.devCommands ?? [];

        try {
          const runtimeStatus = await agentClient.devList(sandbox.id);

          devCommands = configuredCommands.map((cmd) => {
            const runtime = runtimeStatus.commands.find(
              (r) => r.name === cmd.name,
            );
            const isRunning = runtime?.status === "running";

            return {
              name: cmd.name,
              command: cmd.command,
              port: cmd.port,
              status: runtime?.status ?? "stopped",
              devUrl:
                isRunning && cmd.port
                  ? buildDevUrl(sandbox.id, cmd.name)
                  : null,
            };
          });
        } catch {
          // Agent unreachable — return config-only info
          devCommands = configuredCommands.map((cmd) => ({
            name: cmd.name,
            command: cmd.command,
            port: cmd.port,
            status: "unknown",
            devUrl: null,
          }));
        }
      }

      const result = { ...base, devCommands };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
