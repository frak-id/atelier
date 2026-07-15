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
import { PortSchema, ProcessSchema, SourceSchema } from "./sandbox-spec.ts";

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
 * Processes/ports a toolbox contributes to a spawn's spec (entities-toolbox.md).
 * A toolbox is not just files: it can carry the *running surface* of a tool —
 * e.g. vscode's `code-server` process + its public port, or the browser
 * stack's kasmvnc/openbox/chromium processes (whose binaries are baked into
 * the base image, so `build`/`paths` are empty). Merged into the spec at the
 * api/ seam for every toolbox applied to the spawn (auto-injected or picked).
 * Mark long-running surfaces `lazy: true` so they start on demand from the
 * sandbox UI rather than at boot.
 */
const ToolboxProcessesSchema = Type.Array(ProcessSchema, { maxItems: 50 });
const ToolboxPortsSchema = Type.Array(PortSchema, { maxItems: 50 });

/** Caller-supplied shape for create (and the base for patch). */
export const ToolboxConfigInputSchema = Type.Object(
  {
    slug: ToolboxSlugSchema,
    description: Type.String({ minLength: 1, maxLength: 200 }),
    source: Type.Optional(SourceSchema),
    build: BuildStepsSchema,
    paths: ToolboxPathsSchema,
    harness: Type.Optional(ToolboxHarnessSchema),
    processes: Type.Optional(ToolboxProcessesSchema),
    ports: Type.Optional(ToolboxPortsSchema),
    /**
     * Auto-inject this toolbox into every one of the owner's spawns. When
     * false the toolbox is still fully usable — it just isn't applied unless
     * explicitly selected for a spawn (renamed from the old `enabled`, which
     * misleadingly implied on/off existence).
     */
    autoInject: Type.Optional(Type.Boolean()),
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
    processes: Type.Optional(ToolboxProcessesSchema),
    ports: Type.Optional(ToolboxPortsSchema),
    autoInject: Type.Boolean(),
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
    processes: Type.Optional(ToolboxProcessesSchema),
    ports: Type.Optional(ToolboxPortsSchema),
    autoInject: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false, $id: "ToolboxConfigPatch" },
);
export type ToolboxConfigPatch = Static<typeof ToolboxConfigPatchSchema>;
