import type { Plugin } from "@opencode-ai/plugin";
import { createAtelierAdaptor } from "./adaptor.ts";
import { createClientGetter } from "./client.ts";
import { createCommandHook, injectCommands } from "./commands.ts";
import { loadAtelierConfig } from "./config.ts";
import { registerAdaptor } from "./register.ts";
import { resolveWorkspaceId } from "./workspace-resolver.ts";

const atelierPlugin: Plugin = async (input) => {
  const pluginConfig = loadAtelierConfig(input.directory);
  const getClient = createClientGetter(pluginConfig);

  // Auto-resolve workspace from git context (mutates config)
  const resolvedId = await resolveWorkspaceId(
    pluginConfig,
    getClient,
    input.directory,
  );
  if (resolvedId) {
    pluginConfig.workspaceId = resolvedId;
  }

  const adaptor = createAtelierAdaptor(pluginConfig, getClient);
  await registerAdaptor(adaptor);

  console.log(
    `[atelier] Initialized (manager: ${pluginConfig.managerUrl}` +
      `${pluginConfig.workspaceId ? `, workspace: ${pluginConfig.workspaceId}` : ""}` +
      `)`,
  );

  return {
    async config(openCodeConfig) {
      injectCommands(openCodeConfig);
    },
    "command.execute.before": createCommandHook(
      pluginConfig,
      getClient,
      input.client,
    ),
  };
};

export default atelierPlugin;
