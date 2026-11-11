/**
 * Suggested toolboxes: starter recipes the Library offers in each org. The
 * base images ship no agent harness, so a fresh org starts from one of
 * these. Picking one opens the Add toolbox editor prefilled with its recipe,
 * to review (and finish, e.g. a proxy endpoint) before saving: nothing is
 * created server-side until then.
 *
 * Installs track the latest release on purpose: a recipe is content-keyed,
 * so its first build is cached until the toolbox's Refresh (the `refresh`
 * commands below) reinstalls the latest and saves a new version.
 */
import type { ToolboxConfigInput } from "@atelier/spec";

const HOME = "/home/dev";

export interface ToolboxSuggestion {
  /** Stable id, the `?suggestion=` value of the Add toolbox page. */
  id: string;
  title: string;
  /** One line for the suggestion card. */
  summary: string;
  /** Org secrets the recipe's files read. A spawn fails while one is
   * missing from its org. */
  secrets: string[];
  /** What to fill in or check before saving, shown above the editor.
   * Backticks mark code. */
  setup: string[];
  input: ToolboxConfigInput;
}

// ── opencode ────────────────────────────────────────────────────────────────

/** The baseline build: opencode is a Bun binary, and the default build needs
 * AVX2, which a Kata guest may not expose. The tarball holds the binary
 * alone. */
const OPENCODE_TARBALL =
  "https://github.com/anomalyco/opencode/releases/latest/download/opencode-linux-x64-baseline.tar.gz";
const INSTALL_OPENCODE = `curl -fsSL ${OPENCODE_TARBALL} | tar -xz -C ~/.local/bin opencode`;

const OPENCODE: ToolboxSuggestion = {
  id: "opencode",
  title: "opencode",
  summary: "The opencode coding agent, as the sandbox harness.",
  secrets: [],
  setup: [
    "opencode needs model credentials: run `opencode auth login` in a sandbox terminal, or add `/home/dev/.local/share/opencode/auth.json` below as a file read from a secret.",
  ],
  input: {
    slug: "opencode",
    description: "opencode coding agent",
    harness: "opencode",
    build: ["mkdir -p ~/.local/bin", INSTALL_OPENCODE],
    paths: ["~/.local/bin/opencode"],
    refresh: [INSTALL_OPENCODE],
    autoInject: false,
  },
};

// ── pi + CLIProxyAPI ────────────────────────────────────────────────────────

/** pi itself plus `pi-acp`, the ACP bridge the pi harness runs: npm globals
 * under `~/.local` (the harness runs `~/.local/bin/pi-acp`). */
const PI_CORE = ["@earendil-works/pi-coding-agent", "pi-acp"];
const INSTALL_PI = "npm install -g --prefix ~/.local";

/** pi packages, installed into `~/.pi/agent/npm` and listed in
 * `~/.pi/agent/settings.json` by `pi install`. */
const PI_PACKAGES = [
  "pi-subagents",
  "pi-blackhole",
  "pi-intercom",
  "pi-web-access",
  "pi-cliproxyapi",
] as const;

/** The org secret holding the CLIProxyAPI key. */
const CLIPROXY_KEY_SECRET = "CLIPROXY_KEY";
/** Outside the home, so no toolset capture can pick the key up. */
const CLIPROXY_KEY_PATH = "/etc/sandbox/secrets/cliproxy-key";
/** pi-cliproxyapi reads `endpoint` as a literal (no secret, no env var), so
 * the editor opens with this for the user to replace. */
export const CLIPROXY_ENDPOINT_PLACEHOLDER = "https://cliproxy.example.com/v1";

/** pi-cliproxyapi's config: one endpoint + key, and the models routed through
 * it (a provider's `models` is a whitelist; ids absent from the proxy are
 * skipped). `apiKey: "!cmd"` is run and its output used. */
const CLIPROXY_CONFIG = {
  proxy: {
    endpoint: CLIPROXY_ENDPOINT_PLACEHOLDER,
    apiKey: `!cat ${CLIPROXY_KEY_PATH}`,
    providerPrefix: "cliproxy",
  },
  builtinProviders: {
    anthropic: {
      enabled: true,
      models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
    },
    openai: { enabled: true, models: ["gpt-5.5"] },
  },
  customProviders: {},
};

const PI_CLIPROXY: ToolboxSuggestion = {
  id: "pi-cliproxy",
  title: "pi + CLIProxyAPI",
  summary: `The pi coding agent with ${PI_PACKAGES.join(", ")}; models through your CLIProxyAPI.`,
  secrets: [CLIPROXY_KEY_SECRET],
  setup: [
    `In the pi-cliproxyapi config file below, replace \`${CLIPROXY_ENDPOINT_PLACEHOLDER}\` with your CLIProxyAPI endpoint, and trim the model lists to what it serves.`,
    `Add a \`${CLIPROXY_KEY_SECRET}\` secret (your CLIProxyAPI key) to this organization.`,
  ],
  input: {
    slug: "pi-cliproxy",
    description: "pi coding agent, models through CLIProxyAPI",
    harness: "pi",
    build: [
      `${INSTALL_PI} ${PI_CORE.join(" ")}`,
      ...PI_PACKAGES.map((name) => `pi install npm:${name}`),
    ],
    paths: [
      "~/.local/bin/pi",
      "~/.local/bin/pi-acp",
      "~/.local/lib/node_modules",
      "~/.pi/agent/npm",
      "~/.pi/agent/settings.json",
    ],
    files: [
      {
        path: CLIPROXY_KEY_PATH,
        content: { $secret: CLIPROXY_KEY_SECRET },
        mode: "600",
        owner: "dev",
      },
      {
        path: `${HOME}/.pi/agent/pi-cliproxyapi/config.json`,
        content: `${JSON.stringify(CLIPROXY_CONFIG, null, 2)}\n`,
        owner: "dev",
      },
    ],
    refresh: [
      `${INSTALL_PI} ${PI_CORE.map((name) => `${name}@latest`).join(" ")}`,
      "pi update --extensions",
    ],
    autoInject: false,
  },
};

// ── code-server ─────────────────────────────────────────────────────────────

const CODE_SERVER_PORT = 8080;
/** Its own prefix: `~/.local/share/code-server` is code-server's data dir
 * (extensions, state), which a toolset must not own. */
const INSTALL_CODE_SERVER =
  "curl -fsSL https://code-server.dev/install.sh | sh -s -- --method=standalone --prefix=$HOME/.local/lib/code-server";
/** Default user settings: no workspace-trust prompts (the VM is the
 * boundary), no welcome page, no telemetry. Shipped in the toolset rather
 * than as a toolbox file, so a user's own changes survive a reboot (a file
 * is rewritten at every boot; a toolset is the layer under the home). */
const CODE_SERVER_SETTINGS_PATH =
  "~/.local/share/code-server/User/settings.json";
const CODE_SERVER_SETTINGS = {
  "security.workspace.trust.enabled": false,
  "security.workspace.trust.startupPrompt": "never",
  "security.workspace.trust.banner": "never",
  "security.workspace.trust.emptyWindow": false,
  "security.workspace.trust.untrustedFiles": "open",
  "workbench.startupEditor": "none",
  "telemetry.telemetryLevel": "off",
  "workbench.colorTheme": "Default Dark Modern",
};

const CODE_SERVER: ToolboxSuggestion = {
  id: "code-server",
  title: "code-server",
  summary: "VS Code in the browser, started when first opened.",
  secrets: [],
  setup: [],
  input: {
    slug: "code-server",
    description: "VS Code in the browser (code-server)",
    build: [
      INSTALL_CODE_SERVER,
      "mkdir -p ~/.local/bin && ln -sf ~/.local/lib/code-server/bin/code-server ~/.local/bin/code-server",
      // One line (the editor shows a step per line); the JSON has no `'`.
      `mkdir -p ~/.local/share/code-server/User && printf '%s\\n' '${JSON.stringify(CODE_SERVER_SETTINGS)}' > ${CODE_SERVER_SETTINGS_PATH}`,
    ],
    paths: [
      "~/.local/lib/code-server",
      "~/.local/bin/code-server",
      CODE_SERVER_SETTINGS_PATH,
    ],
    processes: [
      {
        name: "vscode",
        command: `code-server --bind-addr 0.0.0.0:${CODE_SERVER_PORT} --auth none --disable-telemetry ${HOME}`,
        cwd: HOME,
        user: "dev",
        lazy: true,
        readiness: { port: CODE_SERVER_PORT },
      },
    ],
    // Auth-less code-server behind the operator's forward-auth ingress.
    ports: [
      {
        name: "vscode",
        port: CODE_SERVER_PORT,
        public: true,
        auth: "forward",
      },
    ],
    refresh: [`rm -rf ~/.local/lib/code-server && ${INSTALL_CODE_SERVER}`],
    autoInject: false,
  },
};

export const TOOLBOX_SUGGESTIONS: readonly ToolboxSuggestion[] = [
  OPENCODE,
  PI_CLIPROXY,
  CODE_SERVER,
];

export function findToolboxSuggestion(
  id: string | undefined,
): ToolboxSuggestion | undefined {
  return TOOLBOX_SUGGESTIONS.find((suggestion) => suggestion.id === id);
}

/** The suggestions an org doesn't have yet: one whose slug is taken there is
 * already added (or shadowed by a toolbox of the same name). */
export function pendingSuggestions(
  toolboxes: readonly { slug: string }[],
): ToolboxSuggestion[] {
  const taken = new Set(toolboxes.map((toolbox) => toolbox.slug));
  return TOOLBOX_SUGGESTIONS.filter(
    (suggestion) => !taken.has(suggestion.input.slug),
  );
}

/** The secrets a suggestion reads that the org doesn't have. */
export function missingSecrets(
  suggestion: ToolboxSuggestion,
  secrets: readonly { name: string }[],
): string[] {
  const names = new Set(secrets.map((secret) => secret.name));
  return suggestion.secrets.filter((name) => !names.has(name));
}
