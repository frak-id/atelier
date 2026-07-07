/**
 * Toolbox-associated toolset versions (docs/toolbox-versions.md). A toolbox
 * version is a control-plane row linking an immutable toolset `ref` to the
 * toolbox it was captured/built for — the "save toolset for toolbox" flow.
 * Runtime's `ToolsetRecord` (`toolset-spec.ts`) never learns about toolboxes;
 * this is the control-side join, kept in its own module so the seam
 * (`api/`) can orchestrate capture (runtime) + version storage (control)
 * without either plane importing the other.
 */
import { type Static, Type } from "@sinclair/typebox";

/**
 * How a version came to exist. `captured` records the live sandbox + user
 * that produced it (result-keyed, per `ToolsetProvenance`'s `captured` kind);
 * `built` records the recipe hash it was built from (input-keyed, per
 * `ToolsetProvenance`'s `built` kind) — recorded lazily on first successful
 * build per hash (docs/toolbox-versions.md §3). Both variants optionally
 * carry the resolved base `sourceImage` at save time, so the console can
 * badge "captured/built against an older base" when `defaultImage` moves
 * (docs/toolbox-versions.md §5).
 */
export const ToolboxVersionProvenanceSchema = Type.Union(
  [
    Type.Object(
      {
        kind: Type.Literal("captured"),
        /** Sandbox id the capture was taken from. */
        capturedFrom: Type.String(),
        /** User who ran the capture. */
        capturedBy: Type.String(),
        /** Resolved base image the sandbox was running at capture time. */
        sourceImage: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal("built"),
        /** The recipe hash (`hashToolset`-equivalent) this build came from. */
        recipeHash: Type.String(),
        /** Resolved base image the recipe built against. */
        sourceImage: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
  ],
  {
    $id: "ToolboxVersionProvenance",
    description:
      "Discriminated on `kind`: captured carries sandbox+user, built carries the recipe hash. Both optionally carry the resolved sourceImage at save time.",
  },
);
export type ToolboxVersionProvenance = Static<
  typeof ToolboxVersionProvenanceSchema
>;

/** A toolbox version row (stored/returned shape). */
export const ToolboxVersionSchema = Type.Object(
  {
    id: Type.String(),
    toolboxId: Type.String(),
    /** Per-toolbox monotonic counter (v1, v2, …), not a global sequence. */
    label: Type.Integer(),
    /** Immutable toolset ref this version points at. */
    ref: Type.String(),
    description: Type.String(),
    provenance: ToolboxVersionProvenanceSchema,
    /**
     * Control-side recipe fingerprint at save time — an independent, display
     * -only hash (`{source, build, paths}`) used to badge "recipe changed
     * since pin". Deliberately not `hashToolset` (that's runtime's build
     * cache key); this fingerprint exists purely so control can compare a
     * pinned version's inputs to the toolbox's current inputs.
     */
    recipeFingerprint: Type.String(),
    createdAt: Type.String(),
  },
  { additionalProperties: false, $id: "ToolboxVersion" },
);
export type ToolboxVersion = Static<typeof ToolboxVersionSchema>;

/** Caller-supplied shape for `POST /toolboxes/:id/versions/capture`. The
 * server derives `name`/`paths`/`exclude` from the toolbox itself (docs/
 * toolbox-versions.md §2 invariant) — the caller only says which sandbox and
 * why. */
export const ToolboxVersionCaptureRequestSchema = Type.Object(
  {
    sandboxId: Type.String(),
    description: Type.String({ minLength: 1, maxLength: 200 }),
  },
  { additionalProperties: false, $id: "ToolboxVersionCaptureRequest" },
);
export type ToolboxVersionCaptureRequest = Static<
  typeof ToolboxVersionCaptureRequestSchema
>;

/** The shape `GET /toolboxes/:id/versions` returns — versions plus the
 * active pin and the toolbox's current recipe fingerprint, so the console can
 * mark the active row and compute the "recipe changed since pin" drift badge
 * without a second round-trip. */
export const ToolboxVersionListSchema = Type.Object(
  {
    versions: Type.Array(ToolboxVersionSchema),
    activeVersionId: Type.Union([Type.String(), Type.Null()]),
    currentRecipeFingerprint: Type.String(),
    /** Best-effort resolved current base image for the toolbox's source —
     * omitted when resolution fails (docs/toolbox-versions.md §5 drift
     * badge). */
    currentSourceImage: Type.Optional(Type.String()),
  },
  { additionalProperties: false, $id: "ToolboxVersionList" },
);
export type ToolboxVersionList = Static<typeof ToolboxVersionListSchema>;
