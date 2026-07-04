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

/** Caller-supplied shape for create (and the base for patch). */
export const ToolboxConfigInputSchema = Type.Object(
  {
    slug: ToolboxSlugSchema,
    description: Type.String({ minLength: 1, maxLength: 200 }),
    source: Type.Optional(SourceSchema),
    build: BuildStepsSchema,
    paths: ToolboxPathsSchema,
    enabled: Type.Optional(Type.Boolean()),
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
    enabled: Type.Boolean(),
    createdAt: Type.String(),
    updatedAt: Type.String(),
  },
  { additionalProperties: false, $id: "ToolboxConfig" },
);
export type ToolboxConfig = Static<typeof ToolboxConfigSchema>;

/**
 * Partial update — everything but `slug` (immutable identity). Includes
 * `enabled` as a first-class field: a pure `{enabled:false}` patch must not
 * touch `build`/`paths` (per-org-toolboxes.md Oracle refinement R9).
 */
export const ToolboxConfigPatchSchema = Type.Object(
  {
    description: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    source: Type.Optional(SourceSchema),
    build: Type.Optional(BuildStepsSchema),
    paths: Type.Optional(ToolboxPathsSchema),
    enabled: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false, $id: "ToolboxConfigPatch" },
);
export type ToolboxConfigPatch = Static<typeof ToolboxConfigPatchSchema>;
