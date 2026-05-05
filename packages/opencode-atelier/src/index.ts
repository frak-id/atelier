import type { Plugin } from "@opencode-ai/plugin";
import { createAtelierAdaptor } from "./adaptor.ts";
import { createClientGetter } from "./client.ts";
import { createCommandHook, injectCommands } from "./commands.ts";
import { loadAtelierConfig } from "./config.ts";
import { getLogFilePath, logger } from "./logger.ts";
import { createSystemPromptTransform } from "./system-prompt.ts";
import { resolveWorkspaceId } from "./workspace-resolver.ts";

const atelierPlugin: Plugin = async (input) => {
  const pluginConfig = loadAtelierConfig(input.directory);
  const getClient = createClientGetter(pluginConfig);

  // Auto-resolve workspace from git context (mutates config)
  const resolvedId = await resolveWorkspaceId(
    pluginConfig,
    getClient,
    input.directory,
    input.$,
  );
  if (resolvedId) {
    pluginConfig.workspaceId = resolvedId;
  }

  input.experimental_workspace.register(
    "atelier",
    createAtelierAdaptor(pluginConfig, getClient),
  );

  const logPath = getLogFilePath();
  logger.info(
    `Initialized (manager: ${pluginConfig.managerUrl}` +
      `${pluginConfig.workspaceId ? `, workspace: ${pluginConfig.workspaceId}` : ""}` +
      `)`,
  );
  // One console line so users know where to tail logs.
  if (logPath) {
    console.log(
      `[atelier] Plugin initialized — logs at ${logPath}`,
    );
  }

  return {
    async config(openCodeConfig) {
      injectCommands(openCodeConfig);
    },
    "command.execute.before": createCommandHook(
      pluginConfig,
      getClient,
      input.client,
    ),
    "experimental.chat.system.transform": createSystemPromptTransform(
      pluginConfig,
      getClient,
    ),
  };
};

export default atelierPlugin;
