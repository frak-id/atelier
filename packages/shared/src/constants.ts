/**
 * Shared constants for Frak Sandbox infrastructure
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
  APP_DIR: "/opt/frak-sandbox",
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

export const NETWORK = {
  /** Bridge device name */
  BRIDGE_NAME: "br0",
  /** Bridge IP address */
  BRIDGE_IP: "172.16.0.1",
  /** Bridge CIDR notation */
  BRIDGE_CIDR: "172.16.0.0/24",
  /** Bridge netmask */
  BRIDGE_NETMASK: "24",
  /** First guest IP (last octet) */
  GUEST_IP_START: 10,
  /** Guest subnet prefix */
  GUEST_SUBNET: "172.16.0",
  /** Test VM IP */
  TEST_VM_IP: "172.16.0.2",
  /** Test VM MAC address */
  TEST_VM_MAC: "06:00:AC:10:00:02",
  /** Test TAP device name */
  TEST_TAP: "tap-test",
} as const;

export const LVM = {
  /** Volume group name */
  VG_NAME: "sandbox-vg",
  /** Thin pool name */
  THIN_POOL: "thin-pool",
  /** Base volume name (legacy, use image volumes) */
  BASE_VOLUME: "base-rootfs",
  /** Base volume size (legacy) */
  BASE_SIZE: "2G",
  /** Image volume prefix */
  IMAGE_PREFIX: "image-",
  /** Prebuild volume prefix */
  PREBUILD_PREFIX: "prebuild-",
  /** Sandbox volume prefix */
  SANDBOX_PREFIX: "sandbox-",
} as const;

export const CADDY = {
  /** Caddy admin API endpoint */
  ADMIN_API: "http://localhost:2019",
  DOMAIN_SUFFIX: "nivelais.com",
} as const;

export const OPENCODE = {
  VERSION: "1.1.36",
  RELEASE_URL: "https://github.com/anomalyco/opencode/releases/download",
  BINARY: "opencode-linux-x64-baseline.tar.gz",
} as const;

export const TTYD = {
  VERSION: "1.7.7",
  RELEASE_URL: "https://github.com/tsl0922/ttyd/releases/download",
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
  /** SSH proxy listen port */
  LISTEN_PORT: 2222,
  /** SSH proxy domain (for external access) */
  DOMAIN: "ssh.nivelais.com",
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

export const NFS = {
  CACHE_EXPORT_DIR: "/var/lib/sandbox/shared-cache",
  BINARIES_EXPORT_DIR: "/var/lib/sandbox/shared-binaries",
  CONFIGS_EXPORT_DIR: "/var/lib/sandbox/shared-configs",
  CACHE_GUEST_MOUNT: "/mnt/cache",
  BINARIES_GUEST_MOUNT: "/opt/shared",
  CONFIGS_GUEST_MOUNT: "/mnt/configs",
  HOST_IP: "172.16.0.1",
  CACHE_DIRS: {
    BUN: "bun",
    NPM: "npm",
    PNPM: "pnpm",
    YARN: "yarn",
    PIP: "pip",
  },
  /** Config directories structure on NFS */
  CONFIG_DIRS: {
    GLOBAL: "global",
    WORKSPACES: "workspaces",
  },
} as const;

/** Manager internal API for sandbox communication */
export const MANAGER_INTERNAL = {
  HOST: "172.16.0.1",
  PORT: 4000,
  BASE_URL: "http://172.16.0.1:4000/internal",
} as const;

/** Known auth providers that sync between sandboxes via shared_auth */
export const AUTH_PROVIDERS = [
  {
    name: "opencode",
    path: "/home/dev/.local/share/opencode/auth.json",
    description: "OpenCode authentication (Anthropic, XAI, OpenCode API keys)",
  },
  {
    name: "antigravity",
    path: "/home/dev/.config/opencode/antigravity-accounts.json",
    description: "Google Antigravity plugin accounts",
  },
] as const;

export type AuthProviderName = (typeof AUTH_PROVIDERS)[number]["name"];

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

export const SESSION_TEMPLATES_CONFIG_PATH =
  "/.frak-sandbox/session-templates.json";
