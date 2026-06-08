import { VM } from "./infra.ts";

export const VM_PATHS = {
  opencodeAuth: `${VM.HOME}/.local/share/opencode/auth.json`,
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
