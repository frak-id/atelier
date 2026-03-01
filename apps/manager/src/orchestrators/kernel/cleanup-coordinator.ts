import { KubeClient } from "../../infrastructure/kubernetes/index.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";

const log = createChildLogger("cleanup-coordinator");

export interface CleanupResources {
  podName?: string;
  pid?: number;
  paths?: {
    socket?: string;
    vsock?: string;
    pid?: string;
    log?: string;
    overlay?: string;
    useLvm?: boolean;
  };
  network?: {
    ipAddress?: string;
    macAddress?: string;
    tapDevice?: string;
    gateway?: string;
  };
}

export async function cleanupSandboxResources(
  sandboxId: string,
  resources: CleanupResources,
): Promise<void> {
  const kube = new KubeClient();
  const selector = `atelier.dev/sandbox=${sandboxId}`;

  try {
    await kube.deleteLabeledResources(selector);

    if (resources.podName) {
      await kube
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
