import { AUTH_PROVIDERS, VM_PATHS } from "@frak-sandbox/shared/constants";
import type { SandboxConfig } from "@frak-sandbox/shared/sandbox-config";
import { loadSandboxConfig } from "@frak-sandbox/shared/sandbox-config-loader";

export const sandboxConfig: SandboxConfig | null = loadSandboxConfig(
  VM_PATHS.config,
);

export const AGENT_PORT = sandboxConfig?.services.agent.port ?? 9999;
export const LOG_DIR = "/var/log/sandbox";
export const WORKSPACE_DIR = "/home/dev/workspace";

export const DEFAULT_EXEC_TIMEOUT = 30000;
export const MAX_EXEC_BUFFER = 10 * 1024 * 1024;

export { AUTH_PROVIDERS, VM_PATHS };
export type { SandboxConfig };
