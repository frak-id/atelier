/**
 * The Launchpad contract (docs/proposals/launchpad.md): the non-technical
 * surface over Atelier. A dev team authors **starters** (a curated recipe +
 * the services to surface); anyone launches one into a **workspace** (a
 * sandbox with a user-owned title/description).
 *
 * Control-plane content only — the runtime never sees a starter. The api/
 * seam turns a starter's `recipe` into the same `CreateSandboxRequest` a
 * developer would POST, so enrichment/toolboxes/org policy apply unchanged.
 *
 * The pure helpers below (service resolution, autostart set, phase mapping,
 * launch-request assembly) are shared by the server and the console, with no
 * Node or DOM APIs.
 */
import { type Static, Type } from "@sinclair/typebox";
import {
  type CreateSandboxRequest,
  CreateSandboxRequestSchema,
} from "./create-request.ts";
import type { SandboxStatus, SandboxUrl } from "./runtime-api.ts";

// ── icons ───────────────────────────────────────────────────────────────────

/**
 * The curated icon keys a starter or service may name. Kept as data (not an
 * enum in the schema) so adding one is a console change only; an unknown key
 * falls back to a generic icon instead of failing validation.
 */
export const LAUNCHPAD_ICONS = [
  "sparkles",
  "rocket",
  "globe",
  "eye",
  "layout",
  "palette",
  "pen",
  "message",
  "bot",
  "code",
  "terminal",
  "book",
  "database",
  "chart",
  "shield",
  "bug",
  "flask",
  "megaphone",
] as const;
export type LaunchpadIcon = (typeof LAUNCHPAD_ICONS)[number];

const IconSchema = Type.String({ minLength: 1, maxLength: 40 });

// ── services ────────────────────────────────────────────────────────────────

/** A sandbox port (by its `ports[].name`), optionally deep-linked. */
const PortTargetSchema = Type.Object(
  {
    port: Type.String({ minLength: 1, maxLength: 63 }),
    path: Type.Optional(
      Type.String({
        maxLength: 500,
        pattern: "^/",
        description: 'Appended to the port URL, e.g. "/admin".',
      }),
    ),
  },
  { additionalProperties: false },
);

/** A static link. `{sandboxId}` is substituted at resolution time. */
const UrlTargetSchema = Type.Object(
  {
    url: Type.String({
      minLength: 1,
      maxLength: 2000,
      pattern: "^https?://",
    }),
  },
  { additionalProperties: false },
);

/**
 * One tile on a workspace: what a non-technical user clicks to reach a tool
 * (the agent's web UI, the app preview, an admin panel, the staging site).
 * Modeled on Coder's `coder_app` and Gitpod's `ports[].onOpen`.
 */
export const LaunchpadServiceSchema = Type.Object(
  {
    id: Type.String({
      pattern: "^[a-z0-9]+(-[a-z0-9]+)*$",
      minLength: 1,
      maxLength: 50,
      description: "Stable, kebab-case key, unique within the starter.",
    }),
    label: Type.String({ minLength: 1, maxLength: 60 }),
    description: Type.Optional(Type.String({ maxLength: 200 })),
    icon: Type.Optional(IconSchema),
    target: Type.Union([PortTargetSchema, UrlTargetSchema]),
    /** `embed` (default) opens in-page as an iframe; `external` opens a new
     * tab. Use `external` for apps that refuse framing (X-Frame-Options /
     * frame-ancestors) — the browser can't detect that for us. */
    open: Type.Optional(
      Type.Union([Type.Literal("embed"), Type.Literal("external")]),
    ),
    /** Start the port's (lazy) gating processes right after launch and on
     * every wake-up. Default true; ignored for `url` targets. */
    autostart: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false, $id: "LaunchpadService" },
);
export type LaunchpadService = Static<typeof LaunchpadServiceSchema>;

// ── starters ────────────────────────────────────────────────────────────────

/** What an author submits to create a starter (and the base for a patch). */
export const StarterInputSchema = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 80 }),
    description: Type.String({ maxLength: 400 }),
    icon: Type.Optional(IconSchema),
    /** Short plain-language how-to shown on the workspace page. */
    guide: Type.Optional(Type.String({ maxLength: 4000 })),
    /** Listed on the Launchpad. Unpublished starters stay authoring-only. */
    published: Type.Optional(Type.Boolean()),
    /** The spawn recipe, exactly what `POST /v1/sandboxes` accepts. */
    recipe: CreateSandboxRequestSchema,
    services: Type.Array(LaunchpadServiceSchema, { maxItems: 20 }),
  },
  { additionalProperties: false, $id: "StarterInput" },
);
export type StarterInput = Static<typeof StarterInputSchema>;

export const StarterPatchSchema = Type.Partial(StarterInputSchema, {
  additionalProperties: false,
  $id: "StarterPatch",
});
export type StarterPatch = Static<typeof StarterPatchSchema>;

/** A stored starter. Owned like a toolbox: an org (the tech team's curated
 * catalog) or a user (a personal one). */
export interface Starter extends StarterInput {
  id: string;
  ownerType: "org" | "user";
  ownerId: string;
  published: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Cross-field checks the schema can't express. Returns human-readable
 * problems (empty = valid): service ids must be unique so a tile keeps a
 * stable identity.
 */
export function starterInputProblems(
  input: Pick<StarterInput, "services">,
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const service of input.services) {
    if (seen.has(service.id)) {
      problems.push(`Duplicate service id "${service.id}"`);
    }
    seen.add(service.id);
  }
  return problems;
}

// ── workspaces ──────────────────────────────────────────────────────────────

/** The starter's presentation, frozen at launch: editing or deleting the
 * starter later never breaks a workspace, and the tiles stay consistent with
 * the spec the sandbox actually booted. */
export interface WorkspaceSnapshot {
  starterTitle: string;
  icon?: string;
  guide?: string;
  services: LaunchpadService[];
}

export const LaunchRequestSchema = Type.Object(
  {
    title: Type.Optional(Type.String({ maxLength: 120 })),
    description: Type.Optional(Type.String({ maxLength: 1000 })),
  },
  { additionalProperties: false, $id: "LaunchRequest" },
);
export type LaunchRequest = Static<typeof LaunchRequestSchema>;

export const WorkspacePatchSchema = Type.Object(
  {
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    description: Type.Optional(Type.String({ maxLength: 1000 })),
  },
  { additionalProperties: false, $id: "WorkspacePatch" },
);
export type WorkspacePatch = Static<typeof WorkspacePatchSchema>;

/**
 * A workspace's state in plain terms, derived from the runtime record and
 * the launch job. `gone` means the sandbox was destroyed outside the
 * Launchpad (the row is pruned).
 */
export type WorkspacePhase =
  | "preparing"
  | "starting"
  | "ready"
  | "sleeping"
  | "failed"
  | "gone";

type JobStatusLike = "queued" | "running" | "succeeded" | "failed" | "canceled";

/**
 * Map (runtime record status, launch job status) → phase. The runtime record
 * wins when it exists; before it lands (source resolution, prebuild bake)
 * only the job says anything.
 */
export function workspacePhase(
  sandboxStatus: SandboxStatus | undefined,
  jobStatus: JobStatusLike | undefined,
): WorkspacePhase {
  switch (sandboxStatus) {
    case "running":
      return "ready";
    case "creating":
      return "starting";
    case "paused":
    case "stopped":
      return "sleeping";
    case "error":
      return "failed";
  }
  switch (jobStatus) {
    case "queued":
    case "running":
      return "preparing";
    case "failed":
    case "canceled":
      return "failed";
    default:
      // Succeeded with no record, or no job at all: the sandbox is gone.
      return "gone";
  }
}

/** A service resolved against a live sandbox, ready to render. */
export interface ResolvedService {
  id: string;
  label: string;
  description?: string;
  icon?: string;
  open: "embed" | "external";
  kind: "port" | "link";
  /** Undefined when the port isn't exposed by this sandbox (misconfigured
   * starter, or the toolbox that declares it wasn't applied). */
  url?: string;
  /** Gating processes + readiness, straight from `SandboxUrl` — the shape
   * the console's service gate consumes. */
  processes?: string[];
  ready?: boolean;
}

function joinUrlPath(base: string, path: string | undefined): string {
  if (!path) return base;
  return `${base.replace(/\/+$/, "")}${path}`;
}

/** `ssh` is a command line, not a web page. */
function isWebUrl(url: SandboxUrl): boolean {
  return /^https?:\/\//.test(url.url);
}

/**
 * Resolve a workspace's services against the sandbox's live `urls[]`. With
 * no declared services, every web URL becomes an embedded tile (so a starter
 * that only picks toolboxes still shows something useful).
 */
export function resolveWorkspaceServices(
  services: readonly LaunchpadService[],
  urls: readonly SandboxUrl[],
  sandboxId: string,
): ResolvedService[] {
  if (services.length === 0) {
    return urls.filter(isWebUrl).map((u) => ({
      id: u.name,
      label: u.name,
      open: "embed" as const,
      kind: "port" as const,
      url: u.url,
      ...(u.processes ? { processes: u.processes } : {}),
      ...(u.ready !== undefined ? { ready: u.ready } : {}),
    }));
  }
  return services.map((service) => {
    const base = {
      id: service.id,
      label: service.label,
      ...(service.description ? { description: service.description } : {}),
      ...(service.icon ? { icon: service.icon } : {}),
      open: service.open ?? ("embed" as const),
    };
    if ("url" in service.target) {
      return {
        ...base,
        kind: "link" as const,
        url: service.target.url.replaceAll("{sandboxId}", sandboxId),
      };
    }
    const { port, path } = service.target;
    const match = urls.find((u) => u.name === port);
    if (!match) return { ...base, kind: "port" as const };
    return {
      ...base,
      kind: "port" as const,
      url: joinUrlPath(match.url, path),
      ...(match.processes ? { processes: match.processes } : {}),
      ...(match.ready !== undefined ? { ready: match.ready } : {}),
    };
  });
}

/**
 * The processes to start so the declared services come up: the gating
 * processes of every port service with `autostart !== false` that isn't
 * ready yet, deduped. Undeclared (fallback) services never autostart — the
 * author didn't ask for them.
 */
export function autostartProcesses(
  services: readonly LaunchpadService[],
  urls: readonly SandboxUrl[],
): string[] {
  const names = new Set<string>();
  for (const service of services) {
    if (service.autostart === false || !("port" in service.target)) continue;
    const { port } = service.target;
    const match = urls.find((u) => u.name === port);
    if (!match || match.ready === true) continue;
    for (const name of match.processes ?? []) names.add(name);
  }
  return [...names];
}

/** Annotation carrying the starter id on a launched sandbox (display only —
 * lets the developer console tell a Launchpad workspace apart). */
export const LAUNCHPAD_STARTER_ANNOTATION = "atelier.dev/launchpad-starter";

/**
 * The `CreateSandboxRequest` a launch sends through the seam: the starter's
 * recipe, stamped with the workspace title (the job queue label) and the
 * starter annotation. Server-side only — a consumer never supplies a spec.
 */
export function starterLaunchRequest(
  starter: Pick<Starter, "id" | "recipe">,
  title: string,
): CreateSandboxRequest {
  const { recipe } = starter;
  return {
    ...recipe,
    metadata: { ...recipe.metadata, name: title },
    annotations: {
      ...recipe.annotations,
      [LAUNCHPAD_STARTER_ANNOTATION]: starter.id,
    },
  };
}
