export const VM_PATHS = {
  config: "/etc/sandbox/config.json",
  secrets: "/etc/sandbox/secrets/.env",
  vscodeSettings: "/home/dev/.local/share/code-server/User/settings.json",
  vscodeExtensions: "/etc/sandbox/vscode-extensions.json",
  opencodeAuth: "/home/dev/.local/share/opencode/auth.json",
  opencodeConfig: "/home/dev/.config/opencode/opencode.json",
  opencodeOhMy: "/home/dev/.config/opencode/oh-my-opencode.json",
  antigravityAccounts: "/home/dev/.config/opencode/antigravity-accounts.json",
} as const;

export const AUTH_PROVIDERS = [
  {
    name: "opencode",
    path: VM_PATHS.opencodeAuth,
    description: "OpenCode authentication (Anthropic, XAI, OpenCode API keys)",
  },
  {
    name: "antigravity",
    path: VM_PATHS.antigravityAccounts,
    description: "Google Antigravity plugin accounts",
  },
] as const;

export type DiscoverableConfigCategory = "opencode" | "vscode";

export const DISCOVERABLE_CONFIGS: ReadonlyArray<{
  path: string;
  category: DiscoverableConfigCategory;
}> = [
  { path: VM_PATHS.opencodeAuth, category: "opencode" },
  { path: VM_PATHS.opencodeConfig, category: "opencode" },
  { path: VM_PATHS.opencodeOhMy, category: "opencode" },
  { path: VM_PATHS.antigravityAccounts, category: "opencode" },
  { path: VM_PATHS.vscodeSettings, category: "vscode" },
];

export const CONFIG_SCAN_DIRS: ReadonlyArray<{
  dir: string;
  category: DiscoverableConfigCategory;
}> = [
  { dir: "/home/dev/.local/share/opencode", category: "opencode" },
  { dir: "/home/dev/.config/opencode", category: "opencode" },
  { dir: "/home/dev/.config/opencode/plugins", category: "opencode" },
  { dir: "/home/dev/.config/opencode/providers", category: "opencode" },
];

export interface SandboxConfig {
  sandboxId: string;
  workspaceId?: string;
  workspaceName?: string;
  repos: Array<{ clonePath: string; branch: string }>;
  createdAt: string;
  network: {
    nfsHost: string;
    dashboardDomain: string;
    managerInternalUrl: string;
  };
  services: {
    vscode: { port: number; enabled?: boolean };
    opencode: { port: number; enabled?: boolean };
    terminal: { port: number; enabled?: boolean };
    agent: { port: number; enabled?: boolean };
  };
}

function loadSandboxConfig(path: string): SandboxConfig | null {
  try {
    const text = Deno.readTextFileSync(path);
    return JSON.parse(text) as SandboxConfig;
  } catch {
    return null;
  }
}

export const sandboxConfig: SandboxConfig | null = loadSandboxConfig(
  VM_PATHS.config,
);

export const VSOCK_PORT = 9998;
export const LOG_DIR = "/var/log/sandbox";
export const WORKSPACE_DIR = "/home/dev/workspace";
export const DEFAULT_EXEC_TIMEOUT = 30000;
export const MAX_EXEC_BUFFER = 10 * 1024 * 1024;
