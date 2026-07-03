/**
 * The toolset tier (composed-prebuild-volumes.md). A toolset is a
 * content-addressed `tar.gz` published as an OCI artifact in the in-cluster
 * registry and materialized by the guest agent into native home paths at
 * boot, BEFORE the files/env phase. It is the second prebuild axis beside the
 * repo tier (`prebuild-spec.ts`): repos stay node-local VolumeSnapshots,
 * toolsets are any-node registry artifacts.
 *
 * Two ways a toolset comes to exist, both first-class:
 *   - **built** (input-keyed): `{ base?, build[], paths[] }` executed in a
 *     throwaway pod the same way `prebuild()` executes, except the tail is
 *     "capture the path-sets → push artifact" instead of "snapshot the PVC".
 *     Keyed `hash(base ⊕ build ⊕ paths)` — idempotent, deduped, evictable.
 *   - **captured** (result-keyed): tar the declared path-sets of a live
 *     sandbox (minus secret files), push. Keyed by result, never rebuilt.
 *
 * The runtime never sees a `harness`, `profile`, or toolset *name* on a spec:
 * a `SandboxSpec` references toolsets by resolved digest locator only
 * (`ToolsetRefSchema`). Control/compose resolve names → refs.
 */
import { type Static, Type } from "@sinclair/typebox";
import { SourceSchema } from "./sandbox-spec.ts";

// ── ref (what a SandboxSpec carries) ──────────────────────────────────────

/**
 * A resolved toolset reference — the ONLY toolset shape a `SandboxSpec`
 * carries. Defined in `sandbox-spec.ts` (the spec embeds it, and defining it
 * there keeps the schema module graph acyclic); re-exported here so every
 * toolset shape is reachable from one module.
 */
export { type ToolsetRef, ToolsetRefSchema } from "./sandbox-spec.ts";

/**
 * A toolset name is also its OCI repository path segment(s), so it is
 * constrained to a valid, traversal-free OCI repository name (lowercase
 * alnum + `._-`, slash-separated) — an unconstrained name would let a caller
 * push to `toolsets/../<arbitrary-repo>` in the shared registry.
 */
export const ToolsetNameSchema = Type.String({
  pattern: "^[a-z0-9]+([._-][a-z0-9]+)*(/[a-z0-9]+([._-][a-z0-9]+)*)*$",
  description: "OCI-repo-safe toolset name, e.g. org-toolbox or team/pi.",
});

// ── built (input-keyed) ───────────────────────────────────────────────────

/**
 * Build a reproducible toolset: run `build[]` in a throwaway pod, then capture
 * `paths[]` into an artifact. Same economics as `prebuild()` — content-keyed,
 * deduped, evictable. `env` is build-time only and (like `PrebuildSpec.env`)
 * never enters the content key.
 */
export const ToolsetBuildRequestSchema = Type.Object(
  {
    /** Registry identity, e.g. "org-toolbox" — the artifact repo name. */
    name: ToolsetNameSchema,
    /** Base image OR snapshot to build in (defaults to the sandbox base image). */
    source: Type.Optional(SourceSchema),
    /** Ordered, fail-fast shell steps that install the tools. */
    build: Type.Array(Type.String()),
    /** Home path-sets captured into the artifact (enter the content key). */
    paths: Type.Array(Type.String()),
    /** env available to build steps only (never in the content key). */
    env: Type.Optional(Type.Record(Type.String(), Type.String())),
    /** Opaque pass-through for observability. */
    metadata: Type.Optional(Type.Record(Type.String(), Type.String())),
  },
  {
    additionalProperties: false,
    $id: "ToolsetBuildRequest",
    description: "Build a reproducible, input-keyed toolset artifact.",
  },
);
export type ToolsetBuildRequest = Static<typeof ToolsetBuildRequestSchema>;

// ── captured (result-keyed) ───────────────────────────────────────────────

/**
 * Capture a live sandbox's declared path-sets into a toolset artifact. The
 * agent tars exactly `paths[]` MINUS the exclude globs (known secret files),
 * runs a secret scan over the delta, and pushes. `overrides[]` allow-lists
 * specific paths past a scan finding (an explicit, per-path opt-out).
 */
export const ToolsetCaptureRequestSchema = Type.Object(
  {
    /** Registry identity for the captured artifact. */
    name: ToolsetNameSchema,
    /** Home path-sets to capture (compose-declared defaults + dev additions). */
    paths: Type.Array(Type.String()),
    /** Extra exclude globs beyond the built-in secret-file excludes. */
    exclude: Type.Optional(Type.Array(Type.String())),
    /** Paths explicitly allowed past a secret-scan finding. */
    overrides: Type.Optional(Type.Array(Type.String())),
  },
  {
    additionalProperties: false,
    $id: "ToolsetCaptureRequest",
    description: "Capture a live sandbox's path-sets into a toolset artifact.",
  },
);
export type ToolsetCaptureRequest = Static<typeof ToolsetCaptureRequestSchema>;

// ── provenance + stored entry ─────────────────────────────────────────────

/**
 * How a toolset came to exist. A built toolset records its `build[]` (it can
 * be rebuilt from inputs → freely evictable); a captured one records the
 * sandbox it came from (result-keyed → never silently GC'd).
 */
export const ToolsetProvenanceSchema = Type.Object(
  {
    kind: Type.Union([Type.Literal("built"), Type.Literal("captured")]),
    /** Sandbox id a captured toolset was taken from. */
    capturedFrom: Type.Optional(Type.String()),
    /** Build steps of a built toolset (input provenance). */
    build: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false, $id: "ToolsetProvenance" },
);
export type ToolsetProvenance = Static<typeof ToolsetProvenanceSchema>;

/** A published toolset artifact, as listed by `GET /v1/toolsets`. */
export const ToolsetEntrySchema = Type.Object(
  {
    name: Type.String(),
    /** Host-relative OCI locator (`toolsets/<name>@sha256:…`). */
    ref: Type.String(),
    /** Path-sets the artifact materializes into. */
    paths: Type.Array(Type.String()),
    /** env fragment merged at compose time (e.g. PATH additions). */
    env: Type.Optional(Type.Record(Type.String(), Type.String())),
    provenance: ToolsetProvenanceSchema,
    /**
     * Private-to-the-capturing-user by default (captures). Publishing to the
     * org is an explicit step (proposal §2 secret-scrub constraint).
     */
    private: Type.Boolean(),
    createdAt: Type.String(),
  },
  { additionalProperties: false, $id: "ToolsetEntry" },
);
export type ToolsetEntry = Static<typeof ToolsetEntrySchema>;
