import {
  composeOpencode,
  composePi,
  mergeSpecs,
  PRESETS,
} from "@atelier/compose";
import type { CreateSandboxRequest, SandboxSpec } from "@atelier/spec";
import type { LucideIcon } from "lucide-react";
import {
  Bot,
  Code,
  Cog,
  Globe,
  MessagesSquare,
  MonitorSmartphone,
  SquareTerminal,
  Terminal,
} from "lucide-react";

/**
 * The curated template catalog — see apps/console/design/templates.md for
 * the full generation/correction history and the staging-verified reference
 * this is grounded in. A `Template` is a small declarative record;
 * `templateToRequest` turns it into a `CreateSandboxRequest` using the real
 * `@atelier/compose` SDK, never hand-written processes/provider JSON.
 */
export type TemplateSurface = "vscode" | "browser" | "terminal";

export interface Template {
  id: string;
  name: string;
  description: string;
  category: "agent" | "editor" | "base" | "workstation";
  icon: LucideIcon;
  source: { image: string } | { snapshot: string };
  resources: { vcpus: number; memoryMb: number; diskGb?: number };
  harness?: "opencode" | "pi";
  surfaces?: TemplateSurface[];
  /** A user-owned toolbox slug (`pi`) this template needs on top of the
   * default org toolbox — see notes. Not auto-provisioned by the gallery;
   * the caller must have it (Settings → Toolboxes) or pick it in the picker. */
  requiresToolbox?: string;
  /** This template clones a caller-supplied repo via `postCreate` (see
   * `withRepoClone`) — the gallery must collect a URL before spawning it. */
  needsRepoUrl?: boolean;
  hooks?: { postCreate?: string[]; postStart?: string[] };
  /** Plain-language caveats, surfaced in Builder lens only. */
  notes?: string;
}

/** Core five — the primary gallery grid. */
export const TEMPLATES: Template[] = [
  {
    id: "opencode",
    name: "OpenCode Agent",
    description:
      "Your AI software engineer — ready to read the codebase, write code, fix bugs, and answer questions. Models are pre-wired, just start working.",
    category: "agent",
    icon: Bot,
    source: { image: "dev-base-v2" },
    resources: { vcpus: 2, memoryMb: 2048, diskGb: 20 },
    harness: "opencode",
    surfaces: ["terminal"],
  },
  {
    id: "vscode",
    name: "VS Code + OpenCode",
    description:
      "A full VS Code in your browser with the OpenCode agent alongside — watch and edit files in a real editor while the agent works.",
    category: "editor",
    icon: Code,
    source: { image: "dev-base-v2" },
    resources: { vcpus: 2, memoryMb: 4096, diskGb: 20 },
    harness: "opencode",
    surfaces: ["vscode", "terminal"],
  },
  {
    id: "browser-agent",
    name: "Browser Agent",
    description:
      "An agent with a real Chromium browser — for web research, scraping, and visually verifying or testing a running web app.",
    category: "agent",
    icon: Globe,
    source: { image: "dev-base-v2" },
    resources: { vcpus: 2, memoryMb: 4096, diskGb: 20 },
    harness: "opencode",
    surfaces: ["browser", "terminal"],
  },
  {
    id: "cliproxy-base",
    name: "Base Agent",
    description:
      "A minimal agent + terminal, nothing else — models pre-wired through your organization's proxy (no keys needed). The lean starting point to extend.",
    category: "base",
    icon: Terminal,
    source: { image: "dev-base-v2" },
    resources: { vcpus: 1, memoryMb: 512, diskGb: 20 },
    harness: "opencode",
    surfaces: ["terminal"],
  },
  {
    id: "pi-agent",
    name: "Pi Agent",
    description:
      "The pi coding agent with the cliproxy provider and a curated plugin stack.",
    category: "agent",
    icon: SquareTerminal,
    source: { image: "dev-base-v2" },
    resources: { vcpus: 2, memoryMb: 2048, diskGb: 20 },
    harness: "pi",
    surfaces: ["terminal"],
    requiresToolbox: "pi",
    notes:
      "Needs your personal 'pi' toolbox (installs pi-acp + cliproxy config under ~/.local). Create it once under Settings → Toolboxes, then pick it here — the gallery doesn't provision it automatically.",
  },
];

/** Extras — the full grid (Builder lens) / secondary Operator cards. */
export const TEMPLATES_EXTRA: Template[] = [
  {
    id: "workstation-pro",
    name: "Full Workstation",
    description:
      "High-compute box with editor, browser, and terminal — for heavy, multi-tool work.",
    category: "workstation",
    icon: MonitorSmartphone,
    source: { image: "dev-cloud" },
    resources: { vcpus: 8, memoryMb: 16384 },
    harness: "opencode",
    surfaces: ["vscode", "browser", "terminal"],
  },
  {
    id: "repo-qa",
    name: "Ask a Codebase",
    description:
      "Point it at a repository and ask questions in plain language — no setup, great for reviewing what a team shipped.",
    category: "agent",
    icon: MessagesSquare,
    source: { image: "dev-base-v2" },
    resources: { vcpus: 2, memoryMb: 4096, diskGb: 20 },
    harness: "opencode",
    surfaces: ["terminal"],
    needsRepoUrl: true,
    notes:
      "The repo URL is collected before spawning and threaded into a postCreate clone.",
  },
  {
    id: "rust-agent",
    name: "Rust Agent",
    description: "OpenCode agent on a Rust toolchain base.",
    category: "agent",
    icon: Cog,
    source: { image: "dev-rust" },
    resources: { vcpus: 4, memoryMb: 8192 },
    harness: "opencode",
    surfaces: ["terminal"],
  },
];

/**
 * The Operator lens shows only the lowest-friction, highest-trust cards
 * (`TemplateGallery` filters to these). "Instant Workspace", the plan's third
 * top card, isn't a gallery template — it's the existing prebuild quick-spawn
 * section already on the page (`QuickSpawnSection` in routes/spawn.tsx).
 */
export const OPERATOR_DEFAULT_IDS = ["opencode", "repo-qa"];

/** The full catalog as a single array — both gallery lens branches read this. */
export const ALL_TEMPLATES: Template[] = [...TEMPLATES, ...TEMPLATES_EXTRA];

/** Single-quote-escape a value for safe interpolation into a `sh -c` string. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * A `repo-qa`-style template needs a repo cloned via `postCreate` — the
 * caller (spawn wizard) supplies the URL, this just builds the hook. The URL
 * is validated and both it and the derived directory name are shell-quoted so
 * a URL with spaces/metacharacters can't break or inject into the command.
 */
export function withRepoClone(template: Template, repoUrl: string): Template {
  const url = repoUrl.trim();
  if (!/^https?:\/\/[^\s]+$/.test(url)) {
    throw new Error("Enter a valid http(s) repository URL (no spaces).");
  }
  const name = url.replace(/\/+$/, "").split("/").pop() || "repo";
  return {
    ...template,
    hooks: {
      ...template.hooks,
      postCreate: [
        ...(template.hooks?.postCreate ?? []),
        `git clone --depth 1 ${shellQuote(url)} ${shellQuote(`/home/dev/${name}`)}`,
      ],
    },
  };
}

/**
 * Pure builder: turns a `Template` into a `CreateSandboxRequest` using the
 * real compose SDK (no hand-written processes/ports/provider JSON). Models
 * are never wired here — the org's cliproxy provider config is injected
 * server-side (control/enrichment.ts), templates just pick the harness.
 *
 * `toolboxSelectors` are the caller-picked `tb/<owner>/<slug>` selectors to
 * attach (e.g. the user's own `pi` toolbox for `requiresToolbox: "pi"`
 * templates) — the gallery, not this builder, resolves which selector to use.
 */
export function templateToRequest(
  template: Template,
  toolboxSelectors: string[] = [],
): CreateSandboxRequest {
  const harnessFragment =
    template.harness === "pi"
      ? composePi()
      : template.harness === "opencode"
        ? composeOpencode()
        : {};
  const surfaceFragments = (template.surfaces ?? [])
    .filter(
      (surface): surface is Exclude<TemplateSurface, "terminal"> =>
        surface !== "terminal",
    )
    .map((surface) => PRESETS[surface]());

  const merged = mergeSpecs(harnessFragment, ...surfaceFragments);

  const spec: SandboxSpec = {
    source: template.source,
    resources: template.resources,
    ...merged,
    ...(template.hooks ? { hooks: template.hooks } : {}),
    metadata: { "atelier.dev/template": template.id },
  };

  return {
    ...spec,
    ...(toolboxSelectors.length > 0 ? { toolboxes: toolboxSelectors } : {}),
  };
}
