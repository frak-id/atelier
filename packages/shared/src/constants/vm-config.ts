import { VM } from "./infra.ts";

export const VM_PATHS = {
  config: "/etc/sandbox/config.json",
  secrets: "/etc/sandbox/secrets/.env",
  vscodeSettings: `${VM.HOME}/.local/share/code-server/User/settings.json`,
  vscodeExtensions: "/etc/sandbox/vscode-extensions.json",
  opencodeAuth: `${VM.HOME}/.local/share/opencode/auth.json`,
  opencodeConfig: `${VM.HOME}/.config/opencode/opencode.json`,
  opencodeOhMy: `${VM.HOME}/.config/opencode/oh-my-opencode.json`,
  antigravityAccounts: `${VM.HOME}/.config/opencode/antigravity-accounts.json`,
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
