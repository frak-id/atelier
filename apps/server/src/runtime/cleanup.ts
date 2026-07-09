import { createChildLogger } from "../shared/lib/logger.ts";
import { kubeClient } from "./kube/index.ts";

const log = createChildLogger("cleanup-coordinator");

/**
 * Delete every K8s resource labeled `atelier.dev/sandbox=<id>` — the sandbox
 * pod included: `buildSandboxPod` always stamps that label
 * (`kube.resources.ts` `sandboxLabels`), and `deleteLabeledResources` already
 * sweeps the `pods` collection, so no separate by-name pod delete is needed.
 */
export async function cleanupSandboxResources(
  sandboxId: string,
): Promise<void> {
  const selector = `atelier.dev/sandbox=${sandboxId}`;

  try {
    await kubeClient.deleteLabeledResources(selector);
    log.info({ sandboxId }, "Sandbox resources cleaned up");
  } catch (error) {
    log.warn(
      {
        sandboxId,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to cleanup sandbox resources",
    );
  }
}
