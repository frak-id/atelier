import {
  composeOpencode,
  composePi,
  mergeSpecs,
  PRESETS,
} from "@atelier/compose";
import type { SandboxSpec } from "@atelier/spec";
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
 * Seed examples only (design ui-evolution.md §2.3) — NOT a spawnable gallery.
 * A real "template" is a saved spec with `template: true` (see
 * `settings.templates.tsx` + `template-gallery.tsx`), so the org's own
 * database — not this file — decides what's offered. This catalog exists
 * purely to give a fresh org something to import ('Start from an example')
 * so Builder lens isn't a blank page on day one — importing is the ONLY
 * path in from here (`templateToSavedSpecImport`); nothing here is directly
 * spawnable. See apps/console/design/templates.md for the generation/
 * correction history and the staging-verified reference this is grounded in.
 * A `Template` is a small declarative record built with the real
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
  hooks?: { postCreate?: string[]; postStart?: string[] };
}

/** Core five — the primary seed set. */
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
      "A minimal agent + terminal, nothing else — the lean starting point to extend. Bring model providers via a toolbox or your own config.",
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
    description: "The pi coding agent with a curated plugin stack.",
    category: "agent",
    icon: SquareTerminal,
    source: { image: "dev-base-v2" },
    resources: { vcpus: 2, memoryMb: 2048, diskGb: 20 },
    harness: "pi",
    surfaces: ["terminal"],
  },
];

/** Extras — the rest of the importable seed set. */
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

/** The full seed catalog — the "import example" list (Builder lens only). */
export const ALL_TEMPLATES: Template[] = [...TEMPLATES, ...TEMPLATES_EXTRA];

/**
 * Pure builder: turns a `Template` into a spec fragment using the real
 * compose SDK (no hand-written processes/ports/provider JSON). Models are
 * never wired here — providers come from a toolbox's composed config or the
 * user's own harness config; templates just pick the harness.
 */
function templateToSpec(template: Template): SandboxSpec {
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

  return {
    source: template.source,
    resources: template.resources,
    ...merged,
    ...(template.hooks ? { hooks: template.hooks } : {}),
    metadata: { "atelier.dev/template": template.id },
  };
}

/**
 * Turns a seed `Template` into a saved-spec import body (design
 * ui-evolution.md §2.3, "Start from an example → creates a saved spec you
 * own"). The result is NOT published (`template: false`) — importing is a
 * fork, not an instant gallery entry; the org explicitly publishes it from
 * Settings → Templates (where params/toolboxes/repo-cloning are then
 * authored onto the *saved spec*, not this static seed).
 */
export function templateToSavedSpecImport(template: Template): {
  name: string;
  spec: SandboxSpec;
} {
  return { name: template.name, spec: templateToSpec(template) };
}

/** Single-quote-escape a value for safe interpolation into a `sh -c` string. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * The typed transform behind a gallery template's `repo-url` param (design
 * ui-evolution.md §2.2): appends a validated, shell-quoted `git clone` to
 * `hooks.postCreate` on a *saved spec* (harness-agnostic, spec-level) — no
 * `{{var}}` string interpolation into spec JSON. Used by `TemplateGallery`
 * when spawning a published template that declares a `repo-url` param.
 */
export function applyRepoUrlParam(
  spec: SandboxSpec,
  repoUrl: string,
): SandboxSpec {
  const url = repoUrl.trim();
  if (!/^https?:\/\/[^\s]+$/.test(url)) {
    throw new Error("Enter a valid http(s) repository URL (no spaces).");
  }
  const name = url.replace(/\/+$/, "").split("/").pop() || "repo";
  const hook = `git clone --depth 1 ${shellQuote(url)} ${shellQuote(`/home/dev/${name}`)}`;
  return {
    ...spec,
    hooks: {
      ...spec.hooks,
      postCreate: [...(spec.hooks?.postCreate ?? []), hook],
    },
  };
}
