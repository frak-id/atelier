import type { Config, Hooks, PluginInput } from "@opencode-ai/plugin";
import type { AtelierClient } from "./client.ts";
import { unwrap } from "./client.ts";
import { logger } from "./logger.ts";
import type { AtelierPluginConfig } from "./types.ts";

type OcClient = PluginInput["client"];

export class AtelierHandledError extends Error {
  constructor() {
    super("Command handled by Atelier plugin");
    this.name = "AtelierHandledError";
  }
}

const COMMANDS: Record<string, { template: string; description: string }> = {
  "atelier-tasks": {
    description: "List tasks in the Atelier workspace",
    template: "",
  },
  "atelier-status": {
    description: "Get detailed status of an Atelier task",
    template: "",
  },
  "atelier-sandboxes": {
    description: "List running Atelier sandboxes",
    template: "",
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
  getClient: () => AtelierClient,
  ocClient: OcClient,
): NonNullable<Hooks["command.execute.before"]> {
  return async (input, _output) => {
    const handler = handlers[input.command];
    if (!handler) return;

    const client = getClient();
    let text: string;

    try {
      text = await handler(client, pluginConfig, input.arguments);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Command ${input.command} failed: ${msg}`);
      text = `[atelier] Error fetching data: ${msg}`;
    }

    await ocClient.session.prompt({
      path: { id: input.sessionID },
      body: {
        noReply: true,
        parts: [{ type: "text" as const, text, ignored: true }],
      },
    });

    throw new AtelierHandledError();
  };
}

type Handler = (
  client: AtelierClient,
  config: AtelierPluginConfig,
  args: string,
) => Promise<string>;

const handlers: Record<string, Handler> = {
  "atelier-tasks": async (client, config, args) => {
    const wsId = args.trim() || config.workspaceId;
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
