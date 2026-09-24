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
 * The pure helpers below (service resolution, phase mapping,
 * launch-request assembly) are shared by the server and the console, with no
 * Node or DOM APIs.
 */
import { type Static, Type } from "@sinclair/typebox";
import {
  type CreateSandboxRequest,
  CreateSandboxRequestSchema,
} from "./create-request.ts";
import type { SandboxStatus, SandboxUrl } from "./runtime-api.ts";
import { ToolboxOwnerTypeSchema } from "./toolbox-config-spec.ts";

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
  },
  { additionalProperties: false, $id: "LaunchpadService" },
);
export type LaunchpadService = Static<typeof LaunchpadServiceSchema>;

// ── starters ────────────────────────────────────────────────────────────────

// Field schemas shared by the input, patch and stored shapes.
const StarterTitleSchema = Type.String({ minLength: 1, maxLength: 80 });
const StarterDescriptionSchema = Type.String({ maxLength: 400 });
/** Short plain-language how-to shown on the workspace page. */
const GuideSchema = Type.String({ maxLength: 4000 });
const ServicesSchema = Type.Array(LaunchpadServiceSchema, { maxItems: 20 });

/** What an author submits to create a starter. */
export const StarterInputSchema = Type.Object(
  {
    title: StarterTitleSchema,
    description: StarterDescriptionSchema,
    icon: Type.Optional(IconSchema),
    guide: Type.Optional(GuideSchema),
    /** Listed on the Launchpad. Unpublished starters stay authoring-only. */
    published: Type.Optional(Type.Boolean()),
    /** The spawn recipe, exactly what `POST /v1/sandboxes` accepts. */
    recipe: CreateSandboxRequestSchema,
    services: ServicesSchema,
  },
  { additionalProperties: false, $id: "StarterInput" },
);
export type StarterInput = Static<typeof StarterInputSchema>;

/**
 * Partial update. An absent key keeps its value; `null` clears the optional
 * `icon`/`guide` (JSON drops `undefined`, so clearing needs an explicit
 * value) — mirrors `ToolboxConfigPatchSchema`.
 */
export const StarterPatchSchema = Type.Object(
  {
    title: Type.Optional(StarterTitleSchema),
    description: Type.Optional(StarterDescriptionSchema),
    icon: Type.Optional(Type.Union([IconSchema, Type.Null()])),
    guide: Type.Optional(Type.Union([GuideSchema, Type.Null()])),
    published: Type.Optional(Type.Boolean()),
    recipe: Type.Optional(CreateSandboxRequestSchema),
    services: Type.Optional(ServicesSchema),
  },
  { additionalProperties: false, $id: "StarterPatch" },
);
export type StarterPatch = Static<typeof StarterPatchSchema>;

/** A stored starter. Owned like a toolbox: an org (the tech team's curated
 * catalog) or a user (a personal one). */
export const StarterSchema = Type.Object(
  {
    id: Type.String(),
    ownerType: ToolboxOwnerTypeSchema,
    ownerId: Type.String(),
    title: StarterTitleSchema,
    description: StarterDescriptionSchema,
    icon: Type.Optional(IconSchema),
    guide: Type.Optional(GuideSchema),
    published: Type.Boolean(),
    recipe: CreateSandboxRequestSchema,
    services: ServicesSchema,
    createdAt: Type.String(),
    updatedAt: Type.String(),
  },
  { additionalProperties: false, $id: "Starter" },
);
export type Starter = Static<typeof StarterSchema>;

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
export const WorkspaceSnapshotSchema = Type.Object(
  {
    starterTitle: Type.String(),
    icon: Type.Optional(IconSchema),
    guide: Type.Optional(GuideSchema),
    services: ServicesSchema,
  },
  { additionalProperties: false, $id: "WorkspaceSnapshot" },
);
export type WorkspaceSnapshot = Static<typeof WorkspaceSnapshotSchema>;

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

/** Mirrors the server's `JobStatus` (apps/server/src/runtime/store.ts): the
 * spec package can't import the server, so keep the two in sync by hand. */
type JobStatusLike = "queued" | "running" | "succeeded" | "failed" | "canceled";

/**
 * Map (runtime record status, latest lifecycle job status) → phase. The job
 * is the workspace's most recent launch or wake-up: while it's active it says
 * more than the record (a resuming sandbox stays `paused` until it's back),
 * and before the record lands (source resolution, prebuild bake) it's the
 * only signal. A running record always wins: that's the goal state.
 */
export function workspacePhase(
  sandboxStatus: SandboxStatus | undefined,
  jobStatus: JobStatusLike | undefined,
): WorkspacePhase {
  if (sandboxStatus === "running") return "ready";
  if (jobStatus === "queued" || jobStatus === "running") {
    return sandboxStatus ? "starting" : "preparing";
  }
  switch (sandboxStatus) {
    case "creating":
      return "starting";
    case "paused":
    case "stopped":
      return "sleeping";
    case "error":
      return "failed";
  }
  // No record: the launch failed before it landed, or the sandbox was
  // destroyed elsewhere (succeeded job, or no job left at all).
  return jobStatus === "failed" || jobStatus === "canceled" ? "failed" : "gone";
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
