import { kubeClient } from "../../infrastructure/kubernetes/index.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";

const log = createChildLogger("cleanup-coordinator");

export interface CleanupResources {
  podName?: string;
}

export async function cleanupSandboxResources(
  sandboxId: string,
  resources: CleanupResources,
): Promise<void> {
  const selector = `atelier.dev/sandbox=${sandboxId}`;

  try {
    await kubeClient.deleteLabeledResources(selector);

    if (resources.podName) {
      await kubeClient
        .deleteResource("Pod", resources.podName)
        .catch(() => undefined);
    }

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
