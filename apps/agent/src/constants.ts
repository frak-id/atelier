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

export interface SandboxConfig {
  sandboxId: string;
  workspaceId?: string;
  workspaceName?: string;
  repos: Array<{ clonePath: string; branch: string }>;
  createdAt: string;
  network: {
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
