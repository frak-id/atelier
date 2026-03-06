import {
  type Adaptor,
  type AtelierAdaptorConfig,
  createAtelierAdaptor,
} from "./adaptor";

export type { AtelierAdaptorConfig } from "./adaptor";
export { createAtelierAdaptor } from "./adaptor";
export type { AtelierConfig } from "./client";
export { AtelierClient } from "./client";

export function setupAtelier(
  installAdaptor: (type: string, adaptor: Adaptor) => void,
  config: AtelierAdaptorConfig,
): void {
  installAdaptor("atelier", createAtelierAdaptor(config));
}

type PluginInput = {
  directory: string;
  $: (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    text(): Promise<string>;
    quiet(): { text(): Promise<string> };
  };
};

type Hooks = Record<string, unknown>;

async function resolveRemoteUrl(
  $: PluginInput["$"],
  directory: string,
): Promise<string | undefined> {
  try {
    const result = await $`git -C ${directory} remote get-url origin`
      .quiet()
      .text();
    const url = result.trim();
    return url || undefined;
  } catch {
    return undefined;
  }
}

function loadConfig(): AtelierAdaptorConfig | undefined {
  const managerUrl = process.env.ATELIER_MANAGER_URL ?? process.env.ATELIER_URL;
  if (!managerUrl) return undefined;
  return {
    managerUrl,
    apiKey: process.env.ATELIER_API_KEY,
  };
}

async function tryInstallAdaptor(adaptor: Adaptor): Promise<boolean> {
  const candidates = [
    "opencode/src/control-plane/adaptors",
    "@opencode-ai/opencode/src/control-plane/adaptors",
  ];
  for (const candidate of candidates) {
    try {
      const mod = await import(candidate);
      if (typeof mod.installAdaptor === "function") {
        mod.installAdaptor("atelier", adaptor);
        return true;
      }
    } catch {}
  }
  return false;
}

const plugin = async (input: PluginInput): Promise<Hooks> => {
  const envConfig = loadConfig();
  if (!envConfig) {
    console.warn("[atelier] ATELIER_MANAGER_URL not set, skipping");
    return {};
  }

  const remoteUrl = await resolveRemoteUrl(input.$, input.directory);
  const config: AtelierAdaptorConfig = {
    ...envConfig,
    remoteUrl,
  };

  const adaptor = createAtelierAdaptor(config);
  const installed = await tryInstallAdaptor(adaptor);

  if (!installed) {
    console.warn(
      "[atelier] Could not register adaptor — " +
        "installAdaptor not found in OpenCode internals. " +
        "Workspace type 'atelier' will not be available.",
    );
  }

  return {};
};

export default plugin;
