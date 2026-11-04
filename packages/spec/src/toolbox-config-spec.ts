/**
 * Entity-scoped toolbox configs (entities-toolbox.md). A toolbox config is the
 * control-plane, editable input to a `ToolsetBuildRequest`
 * (`toolset-spec.ts`) — control/compose knowledge, never seen by `runtime/`.
 * Each toolbox is owned by an `org` or a `user` (see `ToolboxOwner`). At
 * spawn, the caller's org's then the caller's own enabled toolboxes are built
 * into `ToolsetRef`s and prepended to `SandboxSpec.toolsets` (the api/ seam,
 * not this package).
 */
import { type Static, Type } from "@sinclair/typebox";
import {
  SurfacePortsSchema,
  SurfaceProcessesSchema,
} from "./runtime-surface.ts";
import { SourceSchema } from "./sandbox-spec.ts";

/**
 * Toolbox owner axis (entities-toolbox.md). A toolbox belongs to either an
 * `org` (place-scoped, mandated baseline) or a `user` (identity-scoped,
 * personal overlay that follows the user into any org's sandboxes). `owner`
 * is a routing/auth concern — it is derived from the request seam, never
 * carried in a create/patch body.
 */
export const ToolboxOwnerTypeSchema = Type.Union(
  [Type.Literal("org"), Type.Literal("user")],
  { $id: "ToolboxOwnerType" },
);
export type ToolboxOwnerType = Static<typeof ToolboxOwnerTypeSchema>;

/** A `{type,id}` owner reference — the single scoping key for a toolbox. */
export interface ToolboxOwner {
  type: ToolboxOwnerType;
  id: string;
}

/** Lowercase-kebab identity, immutable per owner (delete+recreate to rename). */
export const ToolboxSlugSchema = Type.String({
  pattern: "^[a-z0-9]+(-[a-z0-9]+)*$",
  minLength: 1,
  maxLength: 50,
  description: "Lowercase-kebab toolbox slug, e.g. org-toolbox.",
});
export type ToolboxSlug = Static<typeof ToolboxSlugSchema>;

/** Bounded shell build steps (DoS floor on build-pod work). */
const BuildStepsSchema = Type.Array(
  Type.String({ minLength: 1, maxLength: 2000 }),
  { maxItems: 100 },
);
/** Bounded home path-sets to capture (each a home-relative path). */
const ToolboxPathsSchema = Type.Array(
  Type.String({ minLength: 1, maxLength: 300 }),
  { maxItems: 100 },
);

/**
 * Update commands a refresh runs (docs/toolbox-versions.md §10), e.g.
 * `pi update --all`. A refresh boots a throwaway pod from the toolbox's
 * current version, runs these as `dev` in a login shell, and saves the
 * toolbox's `paths[]` as a new pinned version. Empty = no refresh.
 */
const RefreshStepsSchema = Type.Array(
  Type.String({ minLength: 1, maxLength: 2000 }),
  { maxItems: 100 },
);

/**
 * When a refresh runs on its own: a 5-field cron expression or a nickname
 * (`@daily`, `@weekly`), read in UTC. Validated by the server's cron parser
 * (the browser-safe schema only bounds the string).
 */
export const ToolboxRefreshScheduleSchema = Type.String({
  minLength: 1,
  maxLength: 100,
  description: "Cron expression (UTC), e.g. `0 4 * * *` or `@daily`.",
});

/** What started a refresh. */
export const ToolboxRefreshTriggerSchema = Type.Union(
  [Type.Literal("manual"), Type.Literal("schedule")],
  { $id: "ToolboxRefreshTrigger" },
);
export type ToolboxRefreshTrigger = Static<typeof ToolboxRefreshTriggerSchema>;

/**
 * The outcome of a toolbox's last finished refresh (server-written, never in
 * a create/patch body). `updated`: a new version was saved (`versionId`) and
 * pinned unless the pin moved during the refresh (`pinned: false`).
 * `unchanged`: the saved files hashed the same as the current version, so no
 * version was made. `failed`: an update command or the capture failed
 * (`error`); the pin is untouched.
 */
export const ToolboxRefreshStatusSchema = Type.Object(
  {
    at: Type.String(),
    trigger: ToolboxRefreshTriggerSchema,
    outcome: Type.Union([
      Type.Literal("updated"),
      Type.Literal("unchanged"),
      Type.Literal("failed"),
    ]),
    versionId: Type.Optional(Type.String()),
    pinned: Type.Optional(Type.Boolean()),
    error: Type.Optional(Type.String()),
    jobId: Type.Optional(Type.String()),
  },
  { additionalProperties: false, $id: "ToolboxRefreshStatus" },
);
export type ToolboxRefreshStatus = Static<typeof ToolboxRefreshStatusSchema>;

/**
 * Optional harness this toolbox provides (entities-toolbox.md). A harness id
 * (e.g. "opencode", "pi") the api/ seam composes into the spawn's spec when no
 * higher-precedence harness is present (spec > toolbox > org policy). The
 * toolbox's `build[]`/`paths[]` install the agent binary; this field declares
 * that the toolbox also owns the harness *process*.
 */
export const ToolboxHarnessSchema = Type.String({
  pattern: "^[a-z0-9]+(-[a-z0-9]+)*$",
  minLength: 1,
  maxLength: 50,
  description: "Harness id the toolbox provides, e.g. opencode or pi.",
});

/**
 * Caller-supplied shape for create (and the base for patch).
 *
 * A toolbox is not just files: its `processes`/`ports` carry the *runtime
 * surface* of a tool (`runtime-surface.ts`, entities-toolbox.md) — e.g.
 * vscode's `code-server` process + its public port, or the browser stack's
 * kasmvnc/openbox/chromium processes (whose binaries are baked into the
 * base image, so `build`/`paths` are empty). Mark long-running ones
 * `lazy: true` so they start on first access rather than at boot.
 */
export const ToolboxConfigInputSchema = Type.Object(
  {
    slug: ToolboxSlugSchema,
    description: Type.String({ minLength: 1, maxLength: 200 }),
    source: Type.Optional(SourceSchema),
    build: BuildStepsSchema,
    paths: ToolboxPathsSchema,
    harness: Type.Optional(ToolboxHarnessSchema),
    processes: Type.Optional(SurfaceProcessesSchema),
    ports: Type.Optional(SurfacePortsSchema),
    /**
     * Auto-inject this toolbox into every one of the owner's spawns. When
     * false the toolbox is still fully usable — it just isn't applied unless
     * explicitly selected for a spawn (renamed from the old `enabled`, which
     * misleadingly implied on/off existence).
     */
    autoInject: Type.Optional(Type.Boolean()),
    /** Update commands a refresh runs (default none = no refresh). */
    refresh: Type.Optional(RefreshStepsSchema),
    /** Run a refresh on this schedule (needs `refresh` commands). */
    refreshSchedule: Type.Optional(ToolboxRefreshScheduleSchema),
  },
  { additionalProperties: false, $id: "ToolboxConfigInput" },
);
export type ToolboxConfigInput = Static<typeof ToolboxConfigInputSchema>;

/** The stored/returned shape (`GET`/list responses). */
export const ToolboxConfigSchema = Type.Object(
  {
    id: Type.String(),
    ownerType: ToolboxOwnerTypeSchema,
    ownerId: Type.String(),
    slug: ToolboxSlugSchema,
    description: Type.String({ minLength: 1, maxLength: 200 }),
    source: Type.Optional(SourceSchema),
    build: BuildStepsSchema,
    paths: ToolboxPathsSchema,
    harness: Type.Optional(ToolboxHarnessSchema),
    processes: Type.Optional(SurfaceProcessesSchema),
    ports: Type.Optional(SurfacePortsSchema),
    autoInject: Type.Boolean(),
    refresh: RefreshStepsSchema,
    refreshSchedule: Type.Optional(ToolboxRefreshScheduleSchema),
    /** When the schedule next runs a refresh (absent: not scheduled). */
    nextRefreshAt: Type.Optional(Type.String()),
    lastRefresh: Type.Optional(ToolboxRefreshStatusSchema),
    createdAt: Type.String(),
    updatedAt: Type.String(),
  },
  { additionalProperties: false, $id: "ToolboxConfig" },
);
export type ToolboxConfig = Static<typeof ToolboxConfigSchema>;

/**
 * Partial update — everything but `slug` (immutable identity). Includes
 * `autoInject` as a first-class field: a pure `{autoInject:false}` patch must
 * not touch `build`/`paths` (per-org-toolboxes.md Oracle refinement R9).
 */
export const ToolboxConfigPatchSchema = Type.Object(
  {
    description: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    /** `null` clears the source override (revert to the default base image);
     * an absent key keeps the existing value — mirrors `harness`. Needed
     * because JSON serialization drops `undefined`, so the console sends an
     * explicit `null` to clear. */
    source: Type.Optional(Type.Union([SourceSchema, Type.Null()])),
    build: Type.Optional(BuildStepsSchema),
    paths: Type.Optional(ToolboxPathsSchema),
    harness: Type.Optional(Type.Union([ToolboxHarnessSchema, Type.Null()])),
    processes: Type.Optional(SurfaceProcessesSchema),
    ports: Type.Optional(SurfacePortsSchema),
    autoInject: Type.Optional(Type.Boolean()),
    refresh: Type.Optional(RefreshStepsSchema),
    /** `null` turns the schedule off; an absent key keeps it. */
    refreshSchedule: Type.Optional(
      Type.Union([ToolboxRefreshScheduleSchema, Type.Null()]),
    ),
  },
  { additionalProperties: false, $id: "ToolboxConfigPatch" },
);
export type ToolboxConfigPatch = Static<typeof ToolboxConfigPatchSchema>;
