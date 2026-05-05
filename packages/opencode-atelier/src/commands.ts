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
  "atelier-sandboxes": {
    description: "List Atelier sandboxes (optionally filtered by workspace)",
    template: "",
  },
  "atelier-status": {
    description: "Get detailed status of an Atelier sandbox",
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
  "atelier-sandboxes": async (client, config, args) => {
    const wsId = args.trim() || config.workspaceId || undefined;
    const sandboxes = unwrap(
      await client.api.sandboxes.get({
        query: wsId ? { workspaceId: wsId } : {},
      }),
    );

    if (sandboxes.length === 0) {
      return wsId
        ? `No sandboxes in workspace ${wsId}.`
        : "No sandboxes found.";
    }

    const header = wsId
      ? `Sandboxes in workspace ${wsId}:\n`
      : "Atelier Sandboxes:\n";
    const lines = [header];
    for (const sb of sandboxes) {
      const label = sb.name ? `${sb.name} (${sb.id})` : sb.id;
      lines.push(
        `[${sb.status.toUpperCase()}] ${label}`,
        `  Workspace: ${sb.workspaceId ?? "none"}`,
        `  Origin: ${sb.origin?.source ?? "manual"}`,
        `  Resources: ${sb.runtime.vcpus}vCPU / ${sb.runtime.memoryMb}MB`,
        `  OpenCode: ${sb.runtime.urls.opencode}`,
        `  VS Code: ${sb.runtime.urls.vscode}`,
        "",
      );
    }
    return lines.join("\n");
  },

  "atelier-status": async (client, _config, args) => {
    const sandboxId = args.trim();
    if (!sandboxId) {
      return "Usage: /atelier-status <sandbox-id>";
    }

    const sb = unwrap(await client.api.sandboxes({ id: sandboxId }).get());
    const lines = [
      `Sandbox: ${sb.id}`,
      sb.name ? `Name: ${sb.name}` : null,
      `Status: ${sb.status}`,
      `Workspace: ${sb.workspaceId ?? "none"}`,
      sb.origin
        ? `Origin: ${sb.origin.source}${sb.origin.externalId ? ` (${sb.origin.externalId})` : ""}`
        : null,
      `IP: ${sb.runtime.ipAddress}`,
      `Resources: ${sb.runtime.vcpus}vCPU / ${sb.runtime.memoryMb}MB`,
      `OpenCode: ${sb.runtime.urls.opencode}`,
      `VS Code: ${sb.runtime.urls.vscode}`,
      `SSH: ${sb.runtime.urls.ssh}`,
      sb.runtime.urls.browser ? `Browser: ${sb.runtime.urls.browser}` : null,
      `Created: ${sb.createdAt}`,
    ].filter((line): line is string => line !== null);

    return lines.join("\n");
  },
};
