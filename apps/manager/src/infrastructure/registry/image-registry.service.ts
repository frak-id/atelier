import { SandboxError } from "../../shared/errors.ts";
import { config, isMock } from "../../shared/lib/config.ts";

const MANIFEST_CHECK_TIMEOUT_MS = 3000;

export class ImageNotAvailableError extends SandboxError {
  constructor(imageId: string) {
    super(
      `Base image '${imageId}' is not available in the registry (${config.kubernetes.registryUrl}). ` +
        "Build it from the Images page before spawning sandboxes or prebuilds.",
      "IMAGE_NOT_AVAILABLE",
      409,
    );
    this.name = "ImageNotAvailableError";
  }
}

export const ImageRegistryService = {
  /**
   * HEAD /v2/{imageId}/manifests/latest against the OCI registry.
   * Returns null on network failure so callers can fail open: a flaky
   * registry must not block spawns of images that do exist.
   */
  async imageExists(imageId: string): Promise<boolean | null> {
    if (isMock()) return true;
    try {
      const res = await fetch(
        `http://${config.kubernetes.registryUrl}/v2/${imageId}/manifests/latest`,
        {
          method: "HEAD",
          headers: {
            Accept:
              "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.index.v1+json",
          },
          signal: AbortSignal.timeout(MANIFEST_CHECK_TIMEOUT_MS),
        },
      );
      if (res.ok) return true;
      if (res.status === 404) return false;
      return null;
    } catch {
      return null;
    }
  },

  async assertImageAvailable(imageId: string): Promise<void> {
    const exists = await ImageRegistryService.imageExists(imageId);
    if (exists === false) {
      throw new ImageNotAvailableError(imageId);
    }
  },
};
