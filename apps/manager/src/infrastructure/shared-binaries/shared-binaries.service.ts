import { getSharedBinaries } from "@frak/atelier-shared/constants";
import { config, isMock } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import type { KubeClient } from "../kubernetes/kube.client.ts";
import {
  buildSharedBinariesJob,
  buildSharedBinariesPv,
  buildSharedBinariesPvc,
} from "../kubernetes/kube.resources.ts";

const log = createChildLogger("shared-binaries");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PV_NAME = "shared-binaries";
const PVC_NAME = "shared-binaries";
const JOB_NAME_PREFIX = "shared-binaries-update";

const VERSION_ANNOTATION = "atelier.dev/shared-binaries-version";

// ---------------------------------------------------------------------------
// Version fingerprint
// ---------------------------------------------------------------------------

function buildVersionFingerprint(): string {
  const bins = getSharedBinaries({
    opencode: config.advanced.vm.opencode.version,
    codeServer: config.advanced.vm.vscode.version,
  });
  return Object.values(bins)
    .map((b) => `${b.name}@${b.version}`)
    .sort()
    .join(",");
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export const SharedBinariesService = {
  async initialize(kubeClient: KubeClient): Promise<void> {
    if (isMock()) {
      log.info("Mock mode — skipping shared binaries setup");
      return;
    }

    const namespace = config.kubernetes.namespace;

    const pvExists = await kubeClient.resourceExists(
      "PersistentVolume",
      PV_NAME,
      "",
    );
    if (!pvExists) {
      log.info("Creating shared-binaries PersistentVolume");
      await kubeClient.createResource(
        buildSharedBinariesPv(PV_NAME, namespace),
        "",
      );
    }

    const pvcExists = await kubeClient.resourceExists(
      "PersistentVolumeClaim",
      PVC_NAME,
      namespace,
    );
    if (!pvcExists) {
      log.info({ namespace }, "Creating shared-binaries PVC");
      await kubeClient.createResource(
        buildSharedBinariesPvc(PVC_NAME, namespace),
        namespace,
      );

      const bound = await kubeClient.waitForPvcBound(PVC_NAME, {
        timeout: 60_000,
        namespace,
      });
      if (!bound) {
        throw new Error("shared-binaries PVC did not become bound");
      }
    }

    const currentFingerprint = buildVersionFingerprint();
    const storedFingerprint = await this.readPvcAnnotation(
      kubeClient,
      namespace,
    );

    if (storedFingerprint === currentFingerprint) {
      log.info("Shared binaries are up to date");
      return;
    }

    log.info(
      {
        current: currentFingerprint,
        stored: storedFingerprint ?? "(none)",
      },
      "Binary version mismatch — running updater Job",
    );

    await this.runUpdaterJob(kubeClient, namespace, currentFingerprint);
  },

  async runUpdaterJob(
    kubeClient: KubeClient,
    namespace: string,
    fingerprint: string,
  ): Promise<void> {
    const bins = getSharedBinaries({
      opencode: config.advanced.vm.opencode.version,
      codeServer: config.advanced.vm.vscode.version,
    });

    const jobName = `${JOB_NAME_PREFIX}-${Date.now()}`;

    await this.cleanupPreviousJobs(kubeClient, namespace);

    log.info({ jobName }, "Creating shared-binaries updater Job");
    await kubeClient.createResource(
      buildSharedBinariesJob({
        name: jobName,
        namespace,
        pvcName: PVC_NAME,
        binaries: Object.values(bins),
      }),
      namespace,
    );

    const result = await kubeClient.waitForJobComplete(jobName, {
      timeout: 300_000,
      namespace,
    });

    if (result !== "succeeded") {
      let logs = "";
      try {
        const pods = await kubeClient.listPods(
          `job-name=${jobName}`,
          namespace,
        );
        if (pods[0]?.metadata.name) {
          logs = await kubeClient.getPodLogs(pods[0].metadata.name, namespace);
        }
      } catch {}

      log.error({ jobName, result, logs }, "Shared binaries updater failed");
      throw new Error(
        `Shared binaries updater job ${result}: ${logs.slice(0, 500)}`,
      );
    }

    await kubeClient.patch(
      `/api/v1/namespaces/${namespace}/persistentvolumeclaims/${PVC_NAME}`,
      {
        metadata: {
          annotations: { [VERSION_ANNOTATION]: fingerprint },
        },
      },
    );

    log.info({ fingerprint }, "Shared binaries updated successfully");
  },

  async forceUpdate(kubeClient: KubeClient): Promise<void> {
    if (isMock()) return;

    const namespace = config.kubernetes.namespace;
    const fingerprint = buildVersionFingerprint();
    await this.runUpdaterJob(kubeClient, namespace, fingerprint);
  },

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  async readPvcAnnotation(
    kubeClient: KubeClient,
    namespace: string,
  ): Promise<string | undefined> {
    try {
      const pvc = await kubeClient.get<{
        metadata?: { annotations?: Record<string, string> };
      }>(`/api/v1/namespaces/${namespace}/persistentvolumeclaims/${PVC_NAME}`);
      return pvc.metadata?.annotations?.[VERSION_ANNOTATION];
    } catch {
      return undefined;
    }
  },

  async cleanupPreviousJobs(
    kubeClient: KubeClient,
    namespace: string,
  ): Promise<void> {
    try {
      const jobs = await kubeClient.list<{
        items?: Array<{ metadata?: { name?: string } }>;
      }>(
        `/apis/batch/v1/namespaces/${namespace}/jobs?labelSelector=${encodeURIComponent("atelier.dev/component=shared-binaries")}`,
      );

      for (const job of jobs.items ?? []) {
        const name = job.metadata?.name;
        if (!name) continue;
        try {
          await kubeClient.delete(
            `/apis/batch/v1/namespaces/${namespace}/jobs/${name}?propagationPolicy=Background`,
          );
        } catch {}
      }
    } catch {}
  },

  pvcName: PVC_NAME,
};
