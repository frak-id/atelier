import { SandboxError } from "../../shared/errors.ts";
import { isMock } from "../../shared/lib/config.ts";
import {
  qualifyImageName,
  registryUrl,
} from "../../shared/lib/runtime-config.ts";

const MANIFEST_CHECK_TIMEOUT_MS = 3000;

export class ImageNotAvailableError extends SandboxError {
  constructor(imageId: string) {
    super(
      `Base image '${imageId}' is not available in the registry (${registryUrl()}). ` +
        "Build it from the Images page before spawning sandboxes or prebuilds.",
      "IMAGE_NOT_AVAILABLE",
      409,
    );
    this.name = "ImageNotAvailableError";
  }
}

/** The registry gate could not determine whether the image exists (network
 * failure / timeout) — distinct from `ImageNotAvailableError`'s confirmed
 * 404. Retryable: the caller should NOT proceed to boot (that would hang on
 * `ImagePullBackOff` against a registry that might not have the image), but
 * it also must not be conflated with "confirmed missing" (design review R1). */
export class RegistryUnreachableError extends SandboxError {
  constructor(imageId: string) {
    super(
      `Could not verify base image '${imageId}' against the registry ` +
        `(${registryUrl()}) — it is unreachable or timed out. ` +
        "Retry once the registry is reachable.",
      "REGISTRY_UNREACHABLE",
      503,
    );
    this.name = "RegistryUnreachableError";
  }
}

/** Discriminated result of a single registry HEAD (`resolveOrAssert`):
 * either a resolved ref (digest-pinned, or `:latest` when no digest is
 * available), a confirmed 404 (`missing`), or an indeterminate outcome
 * (`unreachable` — network failure/timeout, distinct from a confirmed
 * miss). */
export type ResolveOrAssertResult =
  | { ref: string }
  | { missing: true }
  | { unreachable: true };

export const ImageRegistryService = {
  /**
   * Single HEAD /v2/{imageId}/manifests/latest against the OCI registry,
   * shared by `imageExists`/`assertImageAvailable` and `resolveImageReference`
   * so a caller that needs both "does it exist" and "what's its pinned ref"
   * (the `resolveImage` hot path) does ONE round-trip instead of two
   * near-identical HEADs (design review P2b).
   */
  async resolveOrAssert(imageId: string): Promise<ResolveOrAssertResult> {
    const registry = registryUrl();
    const tagged = `${qualifyImageName(imageId)}:latest`;
    // No external registry (local Docker) or mock: the image is a local-daemon
    // tag — there's nothing to HEAD, so resolve to the bare tag and let
    // `docker run` surface a real error if it isn't present locally.
    if (isMock() || !registry) return { ref: tagged };
    try {
      const res = await fetch(
        `http://${registry}/v2/${imageId}/manifests/latest`,
        {
          method: "HEAD",
          headers: {
            Accept:
              "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.index.v1+json",
          },
          signal: AbortSignal.timeout(MANIFEST_CHECK_TIMEOUT_MS),
        },
      );
      if (res.status === 404) return { missing: true };
      if (!res.ok) return { unreachable: true };
      const digest = res.headers.get("docker-content-digest");
      return { ref: digest ? `${registry}/${imageId}@${digest}` : tagged };
    } catch {
      return { unreachable: true };
    }
  },

  /**
   * HEAD /v2/{imageId}/manifests/latest against the OCI registry.
   * Returns null on network failure so callers can fail open: a flaky
   * registry must not block spawns of images that do exist.
   */
  async imageExists(imageId: string): Promise<boolean | null> {
    const result = await ImageRegistryService.resolveOrAssert(imageId);
    if ("missing" in result) return false;
    if ("unreachable" in result) return null;
    return true;
  },

  async assertImageAvailable(imageId: string): Promise<void> {
    const exists = await ImageRegistryService.imageExists(imageId);
    if (exists === false) {
      throw new ImageNotAvailableError(imageId);
    }
  },

  /**
   * Resolve `{imageId}:latest` to a digest-pinned reference
   * (`{registry}/{imageId}@sha256:…`). A pod pinned to an immutable digest
   * pulls the exact image just built instead of a stale `:latest` the node
   * cached under `imagePullPolicy: IfNotPresent`. Falls back to the `:latest`
   * tag when the digest can't be read (mock mode, flaky registry) so spawns
   * never hard-fail on resolution.
   */
  async resolveImageReference(imageId: string): Promise<string> {
    const tagged = `${qualifyImageName(imageId)}:latest`;
    const result = await ImageRegistryService.resolveOrAssert(imageId);
    return "ref" in result ? result.ref : tagged;
  },
};
