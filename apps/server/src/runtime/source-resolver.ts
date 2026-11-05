/**
 * Turns a spec's `source` into what a boot needs: the concrete image and,
 * for a snapshot source, the snapshot to clone the disk from.
 */
import type { SandboxSpec } from "@atelier/spec";
import { NotFoundError } from "../shared/errors.ts";
import {
  ImageNotAvailableError,
  ImageRegistryService,
  RegistryUnreachableError,
} from "./registry/index.ts";
import type { ImageStore, SnapshotStore } from "./store.ts";

export interface ResolvedSource {
  image: string;
  snapshotName?: string;
}

export class SourceResolver {
  constructor(
    private readonly snapshots: SnapshotStore,
    /** Read-only view of the `images` table (shared with
     * `ImageBuilderService`) so a built image's already-pinned digest wins
     * over re-resolving `:latest` on every spawn. */
    private readonly images: ImageStore,
  ) {}

  async resolveSource(source: SandboxSpec["source"]): Promise<ResolvedSource> {
    if ("snapshot" in source) {
      const snap =
        this.snapshots.get(source.snapshot) ??
        this.snapshots.getByHash(source.snapshot);
      if (!snap) throw new NotFoundError("Snapshot", source.snapshot);
      return { image: snap.image, snapshotName: snap.ref };
    }
    return { image: await this.resolveImage(source) };
  }

  /** Only ever called by `resolveSource` with a non-snapshot source (the
   * `"snapshot" in source` case is resolved there before this runs). */
  private async resolveImage(
    source: Exclude<SandboxSpec["source"], { snapshot: string }>,
  ): Promise<string> {
    // A fully-qualified ref (registry/host or digest) is used verbatim; the
    // gate below only applies to bare names resolved against the configured
    // (in-cluster) registry — an external ref (GHCR, a public tag, another
    // registry entirely) can't be validated by a HEAD against OUR registry,
    // so it would false-negative every BYO image. Let the pod's own pull
    // surface a real error for those instead (design review R1).
    if (source.image.includes("/") || source.image.includes("@")) {
      return source.image;
    }
    // Prefer a built/registered image's already-pinned ref: a `ready`
    // `images` row carries the exact digest we pushed (`<registry>/<name>@
    // sha256:…`) or, for an `external` registration, the verbatim BYO ref.
    // Using it skips the registry round-trip below and pins the same
    // immutable digest the build produced. A row that isn't `ready`
    // (building/error) or has no ref falls through to the live gate, which
    // surfaces the right "not available yet" error.
    const record = this.images.get(source.image);
    if (record?.status === "ready" && record.ref) {
      return record.ref;
    }
    // Fail CLOSED on a confirmed-missing image (404) and on an indeterminate
    // registry (network failure/timeout) alike: a spawn must not hang on
    // ImagePullBackOff against a flaky registry when a clean, retryable
    // error is available here. One HEAD resolves `:latest` to its digest.
    const result = await ImageRegistryService.resolveOrAssert(source.image);
    if ("missing" in result) {
      throw new ImageNotAvailableError(source.image);
    }
    if ("unreachable" in result) {
      throw new RegistryUnreachableError(source.image);
    }
    return result.ref;
  }
}
