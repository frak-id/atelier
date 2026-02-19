import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import {
  agentClient,
  sandboxService,
  workspaceService,
} from "../../container.ts";
import { CaddyService } from "../../infrastructure/proxy/index.ts";
import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";

const log = createChildLogger("mcp-dev-commands");

function buildDevUrl(sandboxId: string, cmdName: string): string {
  return `https://dev-${cmdName}-${sandboxId}.${config.domain.baseDomain}`;
}

function buildDefaultDevUrl(sandboxId: string): string {
  return `https://dev-${sandboxId}.${config.domain.baseDomain}`;
}

export function registerDevCommandTools(server: McpServer): void {
  server.registerTool(
    "list_dev_commands",
    {
      title: "List Dev Commands",
      description:
        "List all configured dev commands for a sandbox with their " +
        "current runtime status and public URLs.",
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

      const workspace = sandbox.workspaceId
        ? workspaceService.getById(sandbox.workspaceId)
        : undefined;
      const configuredCommands = workspace?.config.devCommands ?? [];

      if (configuredCommands.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  sandboxId,
                  commands: [],
                  message: "No dev commands configured",
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      let runtimeStatus: {
        commands: {
          name: string;
          status: string;
          pid?: number;
          startedAt?: string;
          exitCode?: number;
        }[];
      } = { commands: [] };
      if (sandbox.status === "running") {
        try {
          runtimeStatus = await agentClient.devList(sandbox.id);
        } catch {
          // Agent unreachable
        }
      }

      const commands = configuredCommands.map((cmd) => {
        const runtime = runtimeStatus.commands.find((r) => r.name === cmd.name);
        const isRunning = runtime?.status === "running";

        return {
          name: cmd.name,
          command: cmd.command,
          port: cmd.port ?? null,
          workdir: cmd.workdir ?? null,
          isDefault: cmd.isDefault ?? false,
          status: runtime?.status ?? "stopped",
          pid: runtime?.pid ?? null,
          startedAt: runtime?.startedAt ?? null,
          exitCode: runtime?.exitCode ?? null,
          devUrl:
            isRunning && cmd.port ? buildDevUrl(sandbox.id, cmd.name) : null,
          defaultDevUrl:
            isRunning && cmd.port && cmd.isDefault
              ? buildDefaultDevUrl(sandbox.id)
              : null,
        };
      });

      const result = { sandboxId, commands };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.registerTool(
    "manage_dev_commands",
    {
      title: "Manage Dev Commands",
      description:
        "Start or stop dev commands on a sandbox. " +
        "Returns the updated status and public URLs for each command.",
      inputSchema: z.object({
        sandboxId: z.string().describe("The sandbox ID"),
        actions: z
          .array(
            z.object({
              name: z.string().describe("Dev command name"),
              action: z.enum(["start", "stop"]).describe("Action to perform"),
            }),
          )
          .describe("List of actions to perform on dev commands"),
      }),
    },
    async ({ sandboxId, actions }) => {
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
              text: `Sandbox '${sandboxId}' is not running (status: ${sandbox.status})`,
            },
          ],
          isError: true,
        };
      }

      const workspace = sandbox.workspaceId
        ? workspaceService.getById(sandbox.workspaceId)
        : undefined;
      const configuredCommands = workspace?.config.devCommands ?? [];

      const results = [];

      for (const { name, action } of actions) {
        const devCommand = configuredCommands.find((c) => c.name === name);
        if (!devCommand) {
          results.push({
            name,
            action,
            error: `Dev command '${name}' not found`,
          });
          continue;
        }

        try {
          if (action === "start") {
            const devCommandWithEnv = {
              ...devCommand,
              env: {
                ...devCommand.env,
                ATELIER_SANDBOX_ID: sandbox.id,
              },
            };

            const startResult = await agentClient.devStart(
              sandbox.id,
              name,
              devCommandWithEnv,
            );

            let devUrl: string | undefined;
            let defaultDevUrl: string | undefined;

            if (devCommand.port) {
              try {
                const urls = await CaddyService.registerDevRoute(
                  sandbox.id,
                  sandbox.runtime.ipAddress,
                  name,
                  devCommand.port,
                  devCommand.isDefault ?? false,
                  devCommand.extraPorts,
                );
                devUrl = urls.namedUrl;
                defaultDevUrl = urls.defaultUrl;
              } catch (err) {
                log.warn(
                  { sandboxId, name, error: err },
                  "Failed to register dev route",
                );
              }
            }

            results.push({
              name,
              action: "start",
              status: startResult.status,
              pid: startResult.pid ?? null,
              devUrl: devUrl ?? null,
              defaultDevUrl: defaultDevUrl ?? null,
            });
          } else {
            const stopResult = await agentClient.devStop(sandbox.id, name);

            if (devCommand.port) {
              try {
                await CaddyService.removeDevRoute(
                  sandbox.id,
                  name,
                  devCommand.isDefault ?? false,
                  devCommand.extraPorts,
                );
              } catch (err) {
                log.warn(
                  { sandboxId, name, error: err },
                  "Failed to remove dev route",
                );
              }
            }

            results.push({
              name,
              action: "stop",
              status: stopResult.status,
              exitCode: stopResult.exitCode ?? null,
            });
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          results.push({ name, action, error: msg });
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ sandboxId, results }, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    "get_dev_command_logs",
    {
      title: "Get Dev Command Logs",
      description:
        "Get logs for a running dev command. Returns the log content " +
        "and a nextOffset for pagination.",
      inputSchema: z.object({
        sandboxId: z.string().describe("The sandbox ID"),
        name: z.string().describe("Dev command name"),
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
    async ({ sandboxId, name, offset, limit }) => {
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

      try {
        const logs = await agentClient.devLogs(
          sandbox.id,
          name,
          offset ?? 0,
          limit ?? 10000,
        );

        return {
          content: [{ type: "text", text: JSON.stringify(logs, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Failed to get logs: ${msg}` }],
          isError: true,
        };
      }
    },
  );
}
