import type { Plugin } from "@opencode-ai/plugin";
import { createAtelierAdaptor } from "./adaptor.ts";
import { createCommandHook, injectCommands } from "./commands.ts";
import { registerAdaptor } from "./register.ts";
import type { AtelierPluginConfig } from "./types.ts";

function resolveConfig(): AtelierPluginConfig {
  const managerUrl =
    process.env["ATELIER_MANAGER_URL"] ?? "http://localhost:4000";

  return {
    managerUrl,
    defaultWorkspaceId: process.env["ATELIER_WORKSPACE_ID"],
    pollIntervalMs: Number(process.env["ATELIER_POLL_INTERVAL_MS"] ?? "3000"),
    pollTimeoutMs: Number(process.env["ATELIER_POLL_TIMEOUT_MS"] ?? "120000"),
  };
}

function mergeUserConfig(
  target: AtelierPluginConfig,
  source: Record<string, unknown>,
) {
  if (typeof source["url"] === "string") {
    target.managerUrl = source["url"];
  }
  if (typeof source["workspaceId"] === "string") {
    target.defaultWorkspaceId = source["workspaceId"];
  }
  if (typeof source["pollIntervalMs"] === "number") {
    target.pollIntervalMs = source["pollIntervalMs"];
  }
  if (typeof source["pollTimeoutMs"] === "number") {
    target.pollTimeoutMs = source["pollTimeoutMs"];
  }
}

const atelierPlugin: Plugin = async (_input) => {
  const pluginConfig = resolveConfig();
  const adaptor = createAtelierAdaptor(pluginConfig);

  await registerAdaptor(adaptor);

  console.log(
    `[atelier-plugin] Initialized ` + `(manager: ${pluginConfig.managerUrl})`,
  );

  return {
    async config(openCodeConfig) {
      const userConfig = (openCodeConfig as Record<string, unknown>).atelier;
      if (userConfig && typeof userConfig === "object") {
        mergeUserConfig(pluginConfig, userConfig as Record<string, unknown>);
        console.log(
          `[atelier-plugin] Config updated from opencode.json ` +
            `(manager: ${pluginConfig.managerUrl})`,
        );
      }

      injectCommands(openCodeConfig);
    },
    "command.execute.before": createCommandHook(pluginConfig),
  };
};

export default atelierPlugin;
