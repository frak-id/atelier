import type { Hooks } from "@opencode-ai/plugin";
import type { AtelierClient } from "./client.ts";
import { unwrap } from "./client.ts";
import type { AtelierPluginConfig } from "./types.ts";

// ---------------------------------------------------------------------------
// System-prompt transform
//
// Injects Atelier-specific context into the model's system prompt so the agent
// is aware that it's running inside a managed sandbox and which slash commands
// it has access to.
// ---------------------------------------------------------------------------

export function createSystemPromptTransform(
  pluginConfig: AtelierPluginConfig,
  getClient: () => AtelierClient,
): NonNullable<Hooks["experimental.chat.system.transform"]> {
  return async (_input, output) => {
    const lines: string[] = [
      "## Atelier Sandbox Integration",
      "",
      "This OpenCode session runs inside a remote Atelier sandbox managed by",
      `the Atelier manager at \`${pluginConfig.managerUrl}\`. Source code, the`,
      "OpenCode server, and any dev servers all run inside the sandbox VM.",
      "",
      "### What this means for you",
      "- Bash commands execute in the sandbox, not on the user's host machine.",
      "- File paths refer to the sandbox filesystem (typically `/home/dev/workspace`).",
      "- Long-running dev commands should run in the background.",
      "- Network is sandboxed; outbound traffic uses the sandbox's egress.",
      "",
      "### Available Atelier slash commands",
      "- `/atelier-tasks [workspaceId]` — list tasks in the current (or given) workspace.",
      "- `/atelier-status <taskId>` — detailed status of a task and its sandbox.",
      "- `/atelier-sandboxes [workspaceId]` — list running sandboxes.",
    ];

    if (pluginConfig.workspaceId) {
      lines.push("", `Current Atelier workspace: \`${pluginConfig.workspaceId}\`.`);

      // Best-effort enrichment with workspace name. Failure is non-fatal —
      // we don't want to delay the chat just because manager is briefly down.
      try {
        const ws = unwrap(
          await getClient()
            .api.workspaces({ id: pluginConfig.workspaceId })
            .get(),
        );
        if (ws?.name) {
          lines.push(`Workspace name: ${ws.name}.`);
        }
      } catch {
        // Manager unreachable — the workspace ID alone is still useful.
      }
    }

    output.system.push(lines.join("\n"));
  };
}
