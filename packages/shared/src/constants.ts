/**
 * Shared constants for L'atelier infrastructure
 */

export const PATHS = {
  /** Main data directory */
  SANDBOX_DIR: "/var/lib/sandbox",
  /** Pre-built kernels */
  KERNEL_DIR: "/var/lib/sandbox/firecracker/kernels",
  /** Rootfs images */
  ROOTFS_DIR: "/var/lib/sandbox/firecracker/rootfs",
  /** Per-sandbox writable layers */
  OVERLAY_DIR: "/var/lib/sandbox/overlays",
  /** Firecracker API sockets */
  SOCKET_DIR: "/var/lib/sandbox/sockets",
  /** Application logs */
  LOG_DIR: "/var/log/sandbox",
  /** Application code */
  APP_DIR: "/opt/atelier",
  /** Git repository cache */
  GIT_CACHE_DIR: "/var/lib/sandbox/git-cache",
  /** Encrypted secrets */
  SECRETS_DIR: "/var/lib/sandbox/secrets",
} as const;

export const FIRECRACKER = {
  VERSION: "1.14.0",
  RELEASE_URL: "https://github.com/firecracker-microvm/firecracker/releases",
  S3_BUCKET: "https://s3.amazonaws.com/spec.ccfc.min",
  /** Path to firecracker binary */
  BINARY_PATH: "/usr/local/bin/firecracker",
} as const;

export const LVM = {
  /** Volume group name */
  VG_NAME: "sandbox-vg",
  /** Thin pool name */
  THIN_POOL: "thin-pool",
  /** Image volume prefix */
  IMAGE_PREFIX: "image-",
  /** Prebuild volume prefix */
  PREBUILD_PREFIX: "prebuild-",
  /** Sandbox volume prefix */
  SANDBOX_PREFIX: "sandbox-",
} as const;

export const OPENCODE = {
  VERSION: "1.1.48",
  RELEASE_URL: "https://github.com/anomalyco/opencode/releases/download",
  BINARY: "opencode-linux-x64-baseline.tar.gz",
} as const;

export const CODE_SERVER = {
  /** code-server version */
  VERSION: "4.108.1",
  /** GitHub releases URL */
  RELEASE_URL: "https://github.com/coder/code-server/releases/download",
} as const;

export const SSH_PROXY = {
  /** sshpiper version */
  VERSION: "1.5.1",
  /** sshpiper binary path */
  BINARY_PATH: "/usr/local/bin/sshpiper",
  /** sshpiper configuration directory */
  CONFIG_DIR: "/var/lib/sandbox/sshpiper",
  /** sshpiper pipes configuration file */
  PIPES_FILE: "/var/lib/sandbox/sshpiper/pipes.yaml",
  /** sshpiper host key */
  HOST_KEY: "/var/lib/sandbox/sshpiper/host_key",
} as const;

export const DEFAULTS = {
  /** Default vCPU count for sandboxes */
  VCPUS: 2,
  /** Default memory in MB */
  MEMORY_MB: 2048,
  /** Maximum sandboxes per host (based on 64GB RAM) */
  MAX_SANDBOXES: 20,
  /** Sandbox boot timeout in ms */
  BOOT_TIMEOUT_MS: 30000,
  /** Default sandbox volume size in GB (sparse - only uses space as written) */
  VOLUME_SIZE_GB: 50,
} as const;

export const REGISTRY = {
  PORT: 4873,
  STORAGE_DIR: "/var/lib/sandbox/registry/storage",
  EVICTION_DAYS: 14,
} as const;

export const SHARED_STORAGE = {
  BINARIES_DIR: "/var/lib/sandbox/shared-binaries",
} as const;

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

export type AuthProviderName = (typeof AUTH_PROVIDERS)[number]["name"];

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

export const SHARED_BINARIES = {
  opencode: {
    name: "opencode",
    version: OPENCODE.VERSION,
    url: `${OPENCODE.RELEASE_URL}/v${OPENCODE.VERSION}/${OPENCODE.BINARY}`,
    extractCommand: "tar -xzf",
    binaryPath: "opencode",
    estimatedSizeMb: 100,
  },
  "code-server": {
    name: "code-server",
    version: CODE_SERVER.VERSION,
    url: `${CODE_SERVER.RELEASE_URL}/v${CODE_SERVER.VERSION}/code-server-${CODE_SERVER.VERSION}-linux-amd64.tar.gz`,
    extractCommand: "tar -xzf",
    binaryPath: `code-server-${CODE_SERVER.VERSION}-linux-amd64`,
    estimatedSizeMb: 500,
  },
} as const;

export type SharedBinaryId = keyof typeof SHARED_BINARIES;

export interface SessionTemplateVariant {
  name: string;
  model: { providerID: string; modelID: string };
  variant?: string;
  agent?: string;
}

export type SessionTemplateCategory = "primary" | "secondary";

export interface SessionTemplate {
  id: string;
  name: string;
  category: SessionTemplateCategory;
  description?: string;
  promptTemplate?: string;
  variants: SessionTemplateVariant[];
  defaultVariantIndex?: number;
}

export const DEFAULT_SESSION_TEMPLATES: SessionTemplate[] = [
  {
    id: "implement",
    name: "Implementation",
    category: "primary",
    description: "Main development work",
    variants: [
      {
        name: "Low Effort",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
        variant: "high",
        agent: "build",
      },
      {
        name: "Medium Effort",
        model: { providerID: "anthropic", modelID: "claude-opus-4-5" },
        variant: "high",
        agent: "build",
      },
      {
        name: "High Effort",
        model: { providerID: "anthropic", modelID: "claude-opus-4-5" },
        variant: "max",
        agent: "build",
      },
      {
        name: "Maximum Effort",
        model: { providerID: "anthropic", modelID: "claude-opus-4-5" },
        variant: "max",
        agent: "plan",
      },
    ],
    defaultVariantIndex: 1,
  },
  {
    id: "best-practices",
    name: "Best Practices Review",
    category: "secondary",
    description: "Review code for best practices and patterns",
    promptTemplate: `Review the changes made in this task for best practices:

1. Check for code quality issues (naming, structure, readability)
2. Identify missing error handling or edge cases
3. Suggest improvements to patterns and architecture
4. Flag any anti-patterns or code smells

Focus on actionable feedback. If changes are needed, implement them directly.`,
    variants: [
      {
        name: "Standard",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
        variant: "high",
        agent: "build",
      },
    ],
    defaultVariantIndex: 0,
  },
  {
    id: "security-review",
    name: "Security Review",
    category: "secondary",
    description: "Analyze code for security vulnerabilities",
    promptTemplate: `Perform a security review of the changes made in this task:

1. Check for injection vulnerabilities (SQL, XSS, command injection)
2. Review authentication and authorization logic
3. Identify sensitive data exposure risks
4. Check for insecure dependencies or configurations
5. Review input validation and sanitization

Flag any security issues found and implement fixes directly.`,
    variants: [
      {
        name: "Standard",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
        variant: "high",
        agent: "build",
      },
    ],
    defaultVariantIndex: 0,
  },
  {
    id: "simplification",
    name: "Simplification",
    category: "secondary",
    description: "Simplify and refactor code",
    promptTemplate: `Review and simplify the code changes in this task:

1. Remove unnecessary complexity and abstractions
2. Consolidate duplicate code
3. Simplify conditional logic
4. Improve function/method signatures
5. Remove dead code

Make the code as simple as possible while maintaining functionality.`,
    variants: [
      {
        name: "Standard",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
        variant: "high",
        agent: "build",
      },
    ],
    defaultVariantIndex: 0,
  },
];

export const SESSION_TEMPLATES_CONFIG_PATH = "/.atelier/session-templates.json";
