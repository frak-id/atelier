import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import {
  agentClient,
  sandboxService,
  workspaceService,
} from "../../container.ts";
import { toolUrl } from "../../orchestrators/tools/registry.ts";
import { resolveDevConfig } from "../../schemas/index.ts";

const DEV_SERVICE = "dev";

function loadDev(sandboxId: string) {
  const sandbox = sandboxService.getById(sandboxId);
  if (!sandbox) return { error: `Sandbox '${sandboxId}' not found` } as const;
  const workspace = sandbox.workspaceId
    ? workspaceService.getById(sandbox.workspaceId)
    : undefined;
  return { sandbox, dev: resolveDevConfig(workspace?.config) } as const;
}

function text(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    ...(isError && { isError: true }),
  };
}

export function registerDevCommandTools(server: McpServer): void {
  server.registerTool(
    "get_dev_server",
    {
      title: "Get Dev Server",
      description:
        "Get the sandbox dev server: its command, public URL, and current " +
        "running status.",
      inputSchema: z.object({
        sandboxId: z.string().describe("The sandbox ID"),
      }),
    },
    async ({ sandboxId }) => {
      const ctx = loadDev(sandboxId);
      if ("error" in ctx) return text({ error: ctx.error }, true);
      const { sandbox, dev } = ctx;
      if (!dev) return text({ sandboxId, configured: false });

      let status = "stopped";
      if (sandbox.status === "running") {
        try {
          const s = await agentClient.serviceStatus(sandbox.id, DEV_SERVICE);
          status = s.running ? "running" : s.status;
        } catch {
          status = "unknown";
        }
      }

      return text({
        sandboxId,
        configured: true,
        command: dev.command,
        url: toolUrl(DEV_SERVICE, sandbox.id),
        status,
      });
    },
  );

  server.registerTool(
    "manage_dev_server",
    {
      title: "Manage Dev Server",
      description: "Start or stop the sandbox dev server.",
      inputSchema: z.object({
        sandboxId: z.string().describe("The sandbox ID"),
        action: z.enum(["start", "stop"]).describe("Action to perform"),
      }),
    },
    async ({ sandboxId, action }) => {
      const ctx = loadDev(sandboxId);
      if ("error" in ctx) return text({ error: ctx.error }, true);
      const { sandbox, dev } = ctx;
      if (!dev) {
        return text(
          { error: "No dev server configured for this workspace" },
          true,
        );
      }
      if (sandbox.status !== "running") {
        return text(
          {
            error: `Sandbox '${sandboxId}' is not running (status: ${sandbox.status})`,
          },
          true,
        );
      }

      const result =
        action === "start"
          ? await agentClient.serviceStart(sandbox.id, DEV_SERVICE)
          : await agentClient.serviceStop(sandbox.id, DEV_SERVICE);

      return text({
        sandboxId,
        action,
        status: result.status,
        url: action === "start" ? toolUrl(DEV_SERVICE, sandbox.id) : undefined,
      });
    },
  );

  server.registerTool(
    "get_dev_server_logs",
    {
      title: "Get Dev Server Logs",
      description:
        "Get logs for the sandbox dev server. Returns the log content and a " +
        "nextOffset for pagination.",
      inputSchema: z.object({
        sandboxId: z.string().describe("The sandbox ID"),
        offset: z
          .number()
          .optional()
          .describe("Byte offset to start reading from. Defaults to 0"),
        limit: z
          .number()
          .optional()
          .describe("Max bytes to return. Defaults to 10000"),
      }),
    },
    async ({ sandboxId, offset, limit }) => {
      const ctx = loadDev(sandboxId);
      if ("error" in ctx) return text({ error: ctx.error }, true);
      const { sandbox } = ctx;
      if (sandbox.status !== "running") {
        return text({ error: `Sandbox '${sandboxId}' is not running` }, true);
      }

      try {
        const logs = await agentClient.serviceLogs(
          sandbox.id,
          DEV_SERVICE,
          offset ?? 0,
          limit ?? 10000,
        );
        return text(logs);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return text({ error: `Failed to get logs: ${msg}` }, true);
      }
    },
  );
}
