/**
 * The Kubernetes + CSI implementation of the runtime backend port — today's
 * behavior verbatim. It delegates to the existing boot/cleanup/ports/kube
 * modules and holds no policy of its own; the mock-mode short-circuits live in
 * `kubeClient.*` (so this backend is mock-safe without an `isMock()` branch of
 * its own — see the implementation log, step 1).
 */
import type { PortEntry, SandboxSpec } from "@atelier/spec";
import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import type { AgentClient } from "../agent/index.ts";
import {
  type BootInput,
  type BootOutput,
  bootSandbox,
  deleteRestartableResources,
} from "../boot.ts";
import { cleanupSandboxResources } from "../cleanup.ts";
import { buildVolumeSnapshot, kubeClient } from "../kube/index.ts";
import { buildPortIngresses, buildPortUrls, sshUrl } from "../ports.ts";
import type {
  SandboxBackend,
  SandboxUrl,
  VolumeBackend,
} from "./backend.types.ts";

const log = createChildLogger("runtime-backend-kube");

/**
 * Select the volume storage plane from `config.storage.provider`. Only `csi`
 * is implemented today; the host-FS ladder (`btrfs`/`reflink`/`copy`) and the
 * OCI-tar prebuild materialization are the deferred, infra-gated pieces (see
 * docs/proposals/portable-runtime-implementation-log.md, step 3). Fail fast
 * at construction rather than silently degrading a misconfigured provider.
 */
export function createVolumeBackend(
  provider: (typeof config.storage)["provider"] = config.storage.provider,
): VolumeBackend {
  if (provider === "csi") return new CsiVolumeBackend();
  throw new Error(
    `storage.provider="${provider}" is not yet implemented; only "csi" is ` +
      "available today (the btrfs/reflink/copy + OCI-tar backends are the " +
      "deferred portability follow-up). Set storage.provider=csi.",
  );
}

/** CSI VolumeSnapshot / PVC storage plane. */
export class CsiVolumeBackend implements VolumeBackend {
  async snapshot(
    pvcName: string,
    ref: string,
    labels: Record<string, string>,
    annotations?: Record<string, string>,
  ): Promise<void> {
    // Idempotent: a forced rebuild can resolve to a `ref` that already exists
    // (same hash slice), so any prior snapshot of that name is deleted first
    // instead of 409ing the create.
    if (await kubeClient.resourceExists("VolumeSnapshot", ref)) {
      await kubeClient.deleteResource("VolumeSnapshot", ref);
      await kubeClient.waitForResourceDeleted("VolumeSnapshot", ref, {
        timeout: 60_000,
      });
    }
    await kubeClient.createResource(
      buildVolumeSnapshot({ name: ref, pvcName, labels, annotations }),
    );
    await kubeClient.waitForVolumeSnapshotReady(ref, { timeout: 120_000 });
  }

  async deleteSnapshot(ref: string): Promise<void> {
    // Best-effort (an already-gone object must still clear the caller's row).
    await kubeClient
      .deleteResource("VolumeSnapshot", ref)
      .catch((err) => log.warn({ ref, err }, "VolumeSnapshot delete failed"));
  }

  volumeExists(pvcName: string): Promise<boolean> {
    return kubeClient.resourceExists("PersistentVolumeClaim", pvcName);
  }
}

/** Kubernetes sandbox orchestration plane. */
export class KubernetesBackend implements SandboxBackend {
  readonly volumes: VolumeBackend = createVolumeBackend();

  boot(
    id: string,
    spec: SandboxSpec,
    input: BootInput,
    agent: AgentClient,
  ): Promise<BootOutput> {
    return bootSandbox(id, spec, input, agent);
  }

  deleteRestartable(id: string): Promise<void> {
    return deleteRestartableResources(id);
  }

  cleanup(id: string): Promise<boolean> {
    return cleanupSandboxResources(id);
  }

  computeExists(id: string): Promise<boolean> {
    return kubeClient.resourceExists("Pod", `sandbox-${id}`);
  }

  async exposePort(id: string, port: PortEntry): Promise<void> {
    // The Service was built at boot from the spec's ports — a live-added port
    // must be patched in too, or the new Ingress points at a Service port that
    // doesn't exist and Traefik 404s until a pause/resume rebuilds the Service.
    // Strategic merge on `spec.ports` (merge key: `port`) appends without
    // clobbering the existing entries.
    await kubeClient.patchResource("Service", `sandbox-${id}`, {
      spec: {
        ports: [{ name: port.name, port: port.port, targetPort: port.port }],
      },
    });
    for (const resource of buildPortIngresses(id, [port])) {
      await kubeClient.createResource(resource);
    }
  }

  urls(id: string, spec: SandboxSpec): SandboxUrl[] {
    return [...buildPortUrls(id, spec.ports), { name: "ssh", url: sshUrl(id) }];
  }
}
