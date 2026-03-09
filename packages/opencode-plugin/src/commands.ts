import type { Hooks } from "@opencode-ai/plugin";
import type { Config } from "@opencode-ai/sdk";
import type { AtelierClient } from "./atelier-api.ts";
import { createClient, unwrap } from "./atelier-api.ts";
import type { AtelierPluginConfig } from "./types.ts";

const COMMANDS: Record<string, { template: string; description: string }> = {
  "atelier-tasks": {
    description: "List tasks in the Atelier workspace",
    template:
      "Show the user the current Atelier tasks. " +
      "The live data is attached below. " +
      "Format it clearly — group by status.\n\n" +
      "$ARGUMENTS",
  },
  "atelier-status": {
    description: "Get detailed status of an Atelier task",
    template:
      "Show the user the detailed status of the " +
      "requested Atelier task. The live data is " +
      "attached below.\n\n$ARGUMENTS",
  },
  "atelier-sandboxes": {
    description: "List running Atelier sandboxes",
    template:
      "Show the user the current Atelier sandboxes. " +
      "The live data is attached below. " +
      "Format it clearly.\n\n$ARGUMENTS",
  },
};

export function injectCommands(config: Config) {
  const commands =
    (config as Record<string, unknown>).command ??
    ({} as Record<string, unknown>);
  (config as Record<string, unknown>).command = commands;

  for (const [name, cmd] of Object.entries(COMMANDS)) {
    (commands as Record<string, unknown>)[name] = {
      template: cmd.template,
      description: cmd.description,
    };
  }
}

export function createCommandHook(
  pluginConfig: AtelierPluginConfig,
): NonNullable<Hooks["command.execute.before"]> {
  return async (input, output) => {
    const handler = handlers[input.command];
    if (!handler) return;

    const client = createClient(pluginConfig.managerUrl, pluginConfig.token);
    try {
      const text = await handler(client, pluginConfig, input.arguments);
      (output.parts as unknown[]).push({ type: "text", text });
    } catch (err) {
      (output.parts as unknown[]).push({
        type: "text",
        text:
          `[atelier-plugin] Error fetching data: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };
}

type Handler = (
  client: AtelierClient,
  config: AtelierPluginConfig,
  args: string,
) => Promise<string>;

const handlers: Record<string, Handler> = {
  "atelier-tasks": async (client, config, args) => {
    const wsId = args.trim() || config.defaultWorkspaceId;
    if (!wsId) {
      return "No workspace ID. Pass it as argument or set ATELIER_WORKSPACE_ID.";
    }

    const tasks = unwrap(
      await client.api.tasks.get({
        query: { workspaceId: wsId },
      }),
    );
    if (tasks.length === 0) {
      return `No tasks in workspace ${wsId}.`;
    }

    const lines = [`Tasks in workspace ${wsId}:\n`];
    for (const t of tasks) {
      lines.push(
        `[${t.status.toUpperCase()}] ${t.id} — ${t.title}`,
        `  Branch: ${t.data.branchName ?? "none"}`,
        `  Sandbox: ${t.data.sandboxId ?? "none"}`,
        `  Sessions: ${t.data.sessions?.length ?? 0}`,
        `  Created: ${t.createdAt}`,
        "",
      );
    }
    return lines.join("\n");
  },

  "atelier-status": async (client, _config, args) => {
    const taskId = args.trim();
    if (!taskId) {
      return "Usage: /atelier-status <task-id>";
    }

    const task = unwrap(await client.api.tasks({ id: taskId }).get());
    const lines = [
      `Task: ${task.id}`,
      `Title: ${task.title}`,
      `Status: ${task.status}`,
      `Description: ${task.data.description}`,
      `Branch: ${task.data.branchName ?? "none"}`,
      `Created: ${task.createdAt}`,
    ];

    if (task.data.sandboxId) {
      try {
        const sb = unwrap(
          await client.api.sandboxes({ id: task.data.sandboxId }).get(),
        );
        lines.push(
          "",
          "Sandbox:",
          `  ID: ${sb.id}`,
          `  Status: ${sb.status}`,
          `  IP: ${sb.runtime.ipAddress}`,
          `  vCPUs: ${sb.runtime.vcpus}`,
          `  Memory: ${sb.runtime.memoryMb}MB`,
          `  OpenCode: ${sb.runtime.urls.opencode}`,
          `  VS Code: ${sb.runtime.urls.vscode}`,
          `  SSH: ${sb.runtime.urls.ssh}`,
        );
        if (sb.runtime.urls.browser) {
          lines.push(`  Browser: ${sb.runtime.urls.browser}`);
        }
      } catch {
        lines.push(`\nSandbox: ${task.data.sandboxId} (unreachable)`);
      }
    }

    if (task.data.sessions?.length) {
      lines.push("", `Sessions (${task.data.sessions.length}):`);
      for (const s of task.data.sessions) {
        lines.push(
          `  ${s.id} [${s.templateId}] ` +
            `(started: ${s.startedAt ?? "pending"})`,
        );
      }
    }

    return lines.join("\n");
  },

  "atelier-sandboxes": async (client, _config, args) => {
    const wsId = args.trim() || undefined;
    const sandboxes = unwrap(
      await client.api.sandboxes.get({
        query: wsId ? { workspaceId: wsId } : {},
      }),
    );

    if (sandboxes.length === 0) {
      return "No sandboxes found.";
    }

    const lines = ["Atelier Sandboxes:\n"];
    for (const sb of sandboxes) {
      lines.push(
        `[${sb.status.toUpperCase()}] ${sb.id}`,
        `  Workspace: ${sb.workspaceId ?? "none"}`,
        `  IP: ${sb.runtime.ipAddress}`,
        `  Resources: ${sb.runtime.vcpus}vCPU / ${sb.runtime.memoryMb}MB`,
        `  OpenCode: ${sb.runtime.urls.opencode}`,
        `  VS Code: ${sb.runtime.urls.vscode}`,
        "",
      );
    }
    return lines.join("\n");
  },
};
