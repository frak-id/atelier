export const AGENT_PORT = 9999;

export const CONFIG_PATH = "/etc/sandbox/config.json";
export const LOG_DIR = "/var/log/sandbox";

export const VSCODE_SETTINGS_PATH =
  "/home/dev/.local/share/code-server/User/settings.json";
export const VSCODE_EXTENSIONS_PATH = "/etc/sandbox/vscode-extensions.json";
export const OPENCODE_AUTH_PATH = "/home/dev/.config/opencode/auth.json";
export const OPENCODE_CONFIG_PATH = "/home/dev/.config/opencode/config.json";

export const KNOWN_CONFIG_PATHS = [
  {
    path: "/home/dev/.config/opencode/auth.json",
    category: "opencode" as const,
  },
  {
    path: "/home/dev/.config/opencode/config.json",
    category: "opencode" as const,
  },
  {
    path: "/home/dev/.local/share/code-server/User/settings.json",
    category: "vscode" as const,
  },
];

export const CONFIG_DIRECTORIES = [
  { dir: "/home/dev/.config/opencode", category: "opencode" as const },
  { dir: "/home/dev/.opencode", category: "opencode" as const },
];

export const DEFAULT_EXEC_TIMEOUT = 30000;
export const MAX_EXEC_BUFFER = 10 * 1024 * 1024;
