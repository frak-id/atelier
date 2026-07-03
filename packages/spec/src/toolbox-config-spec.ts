/**
 * Org-scoped toolbox configs (per-org-toolboxes.md). A toolbox config is the
 * control-plane, editable input to a `ToolsetBuildRequest`
 * (`toolset-spec.ts`) — control/compose knowledge, never seen by `runtime/`.
 * At spawn, an org's enabled toolboxes are built into `ToolsetRef`s and
 * prepended to `SandboxSpec.toolsets` (the api/ seam, not this package).
 */
import { type Static, Type } from "@sinclair/typebox";
import { SourceSchema } from "./sandbox-spec.ts";

/** Lowercase-kebab identity, immutable per org (delete+recreate to rename). */
export const ToolboxSlugSchema = Type.String({
  pattern: "^[a-z0-9]+(-[a-z0-9]+)*$",
  minLength: 1,
  maxLength: 50,
  description: "Lowercase-kebab toolbox slug, e.g. org-toolbox.",
});
export type ToolboxSlug = Static<typeof ToolboxSlugSchema>;

/** Caller-supplied shape for create (and the base for patch). */
export const ToolboxConfigInputSchema = Type.Object(
  {
    slug: ToolboxSlugSchema,
    description: Type.String({ minLength: 1, maxLength: 200 }),
    source: Type.Optional(SourceSchema),
    build: Type.Array(Type.String()),
    paths: Type.Array(Type.String()),
    enabled: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false, $id: "ToolboxConfigInput" },
);
export type ToolboxConfigInput = Static<typeof ToolboxConfigInputSchema>;

/** The stored/returned shape (`GET`/list responses). */
export const ToolboxConfigSchema = Type.Object(
  {
    id: Type.String(),
    orgId: Type.String(),
    slug: ToolboxSlugSchema,
    description: Type.String({ minLength: 1, maxLength: 200 }),
    source: Type.Optional(SourceSchema),
    build: Type.Array(Type.String()),
    paths: Type.Array(Type.String()),
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
    build: Type.Optional(Type.Array(Type.String())),
    paths: Type.Optional(Type.Array(Type.String())),
    enabled: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false, $id: "ToolboxConfigPatch" },
);
export type ToolboxConfigPatch = Static<typeof ToolboxConfigPatchSchema>;
