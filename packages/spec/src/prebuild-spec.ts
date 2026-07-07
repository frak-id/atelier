/**
 * The prebuild spec. Prebuilds CHAIN: `source` may be an image OR another
 * snapshotRef, so a dev's expensive setup is a derived snapshot on top of the
 * workspace snapshot (atelier-v2 §2 "Layered prebuilds").
 *
 * Snapshot key = hash(source ⊕ prebuild files ⊕ build[] ⊕ repos). Runtime
 * content (files/env/processes/ports/postStart) never enters the key.
 */
import { type Static, Type } from "@sinclair/typebox";
import { FileSchema, SourceSchema } from "./sandbox-spec.ts";

/** A repo to clone into the prebuild before running build steps. */
export const PrebuildRepoSchema = Type.Object(
  {
    url: Type.String(),
    branch: Type.Optional(Type.String()),
    clonePath: Type.String(),
  },
  { additionalProperties: false },
);
export type PrebuildRepo = Static<typeof PrebuildRepoSchema>;

export const PrebuildSpecSchema = Type.Object(
  {
    /** image OR snapshotRef → prebuilds chain. */
    source: SourceSchema,
    /** Files staged into the snapshot (enter the content hash). */
    files: Type.Optional(Type.Array(FileSchema)),
    /** env available to build steps only. */
    env: Type.Optional(Type.Record(Type.String(), Type.String())),
    /** Repos cloned before build[] runs (enter the content hash). */
    repos: Type.Optional(Type.Array(PrebuildRepoSchema)),
    /** Ordered, fail-fast shell steps baked into the snapshot. */
    build: Type.Optional(Type.Array(Type.String())),
    /** Opaque pass-through for observability. */
    metadata: Type.Optional(Type.Record(Type.String(), Type.String())),
  },
  {
    additionalProperties: false,
    $id: "PrebuildSpec",
    description: "Chained, content-addressed prebuild request.",
  },
);
export type PrebuildSpec = Static<typeof PrebuildSpecSchema>;

/** A resolved snapshot reference returned by the runtime. */
export const SnapshotRefSchema = Type.Object(
  {
    ref: Type.String({
      description: "Opaque snapshot ref, e.g. snap-ws-frak-7f3a.",
    }),
    hash: Type.String({
      description: "Content hash the snapshot is keyed by.",
    }),
    parent: Type.Optional(
      Type.String({ description: "Parent snapshot ref in the chain." }),
    ),
  },
  { additionalProperties: false, $id: "SnapshotRef" },
);
export type SnapshotRef = Static<typeof SnapshotRefSchema>;

/** A stored prebuild snapshot, as returned by `GET /v1/prebuilds`. Carries
 * the base image, opaque metadata (workspace/repo/branch…) and creation time
 * so the console can list prebuilds and one-tap spawn from them. */
export const PrebuildRecordSchema = Type.Object(
  {
    ref: Type.String(),
    hash: Type.String(),
    image: Type.String(),
    parent: Type.Optional(Type.String()),
    metadata: Type.Optional(Type.Record(Type.String(), Type.String())),
    /** The original request, so the console/checker can replay/refresh it. */
    spec: Type.Optional(PrebuildSpecSchema),
    createdAt: Type.String(),
  },
  { additionalProperties: false, $id: "PrebuildRecord" },
);
export type PrebuildRecord = Static<typeof PrebuildRecordSchema>;
