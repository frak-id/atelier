import { VM } from "@frak/atelier-shared/constants";
import { config } from "../../shared/lib/config.ts";
import type { FileWrite } from "../agent/agent.types.ts";

function npmRegistryUrl(): string {
  return config.kubernetes.npmRegistryUrl;
}

export const RegistryService = {
  /**
   * Build the file writes that point npm/bun/yarn at the configured npm
   * registry. Returns null when no registry is configured so callers leave
   * sandboxes on the public npm registry.
   */
  buildRegistryConfigFiles(): FileWrite[] | null {
    const registryUrl = npmRegistryUrl();
    if (!registryUrl) return null;

    const registryHost = new URL(registryUrl).hostname;

    return [
      {
        path: "/etc/profile.d/registry.sh",
        content: `export NPM_CONFIG_REGISTRY="${registryUrl}"`,
        owner: "root",
      },
      {
        path: "/etc/npmrc",
        content: `registry=${registryUrl}`,
        owner: "root",
      },
      {
        path: `${VM.HOME}/.bunfig.toml`,
        content: `[install]\nregistry = "${registryUrl}"`,
        owner: "dev",
      },
      {
        path: `${VM.HOME}/.yarnrc.yml`,
        content: `npmRegistryServer: "${registryUrl}"\nunsafeHttpWhitelist:\n  - "${registryHost}"`,
        owner: "dev",
      },
    ];
  },
};
