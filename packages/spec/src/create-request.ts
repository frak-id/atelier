/**
 * The `POST /v1/sandboxes` seam input and the template "composition" it comes
 * from. Kept out of `sandbox-spec.ts` because it references `PrebuildSpec`
 * (whose module imports `sandbox-spec.ts`) — defining it here keeps the schema
 * module graph acyclic.
 *
 * The seam resolves the high-level references before the runtime sees a spec:
 * `toolboxes` selectors → materialized toolset refs (latest build), and a
 * `prebuild` recipe → the current snapshot ref (`source.snapshot`). Storing
 * those references — instead of a pinned `source.snapshot`/`toolsets` — is what
 * lets a template follow an updated prebuild or toolbox.
 */
import { type Static, Type } from "@sinclair/typebox";
import { PrebuildSpecSchema } from "./prebuild-spec.ts";
import { SandboxSpecSchema, ToolboxSelectorSchema } from "./sandbox-spec.ts";

/**
 * The `POST /v1/sandboxes` body: a `SandboxSpec` plus optional high-level
 * references the seam resolves. `toolboxes` are selectors resolved to the
 * latest toolset build; `prebuild` is a recipe resolved (idempotently, a cache
 * hit when unchanged) to the current snapshot, overriding `source`. A plain
 * `SandboxSpec` (neither field) is still a valid body, so the
 * CLI/editor/saved-spec paths are unchanged.
 */
export const CreateSandboxRequestSchema = Type.Composite(
  [
    SandboxSpecSchema,
    Type.Object({
      toolboxes: Type.Optional(Type.Array(ToolboxSelectorSchema)),
      prebuild: Type.Optional(PrebuildSpecSchema),
    }),
  ],
  { additionalProperties: false, $id: "CreateSandboxRequest" },
);
export type CreateSandboxRequest = Static<typeof CreateSandboxRequestSchema>;

/**
 * A template's build recipe, stored alongside a saved spec so the template
 * follows updates rather than pinning: a `prebuild` recipe (re-resolved to the
 * latest snapshot at spawn) and `toolboxes` selectors (re-resolved to the
 * latest toolset builds). Presentation-only metadata stays in `TemplateMeta`;
 * this is the part that changes what actually boots.
 */
export const TemplateCompositionSchema = Type.Object(
  {
    // Required: a composition exists to follow a prebuild. `toolboxes` alone
    // would just be a plain `toolboxes` spawn with nothing to re-resolve for
    // `source`, so it stays on the spec/request, not here.
    prebuild: PrebuildSpecSchema,
    toolboxes: Type.Optional(Type.Array(ToolboxSelectorSchema)),
  },
  { additionalProperties: false, $id: "TemplateComposition" },
);
export type TemplateComposition = Static<typeof TemplateCompositionSchema>;
