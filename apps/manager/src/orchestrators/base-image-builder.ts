import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  discoverImages,
  getImageById,
  type ImageDefinition,
} from "@frak/atelier-shared";
import type { ImageBuilder } from "../infrastructure/image-builder/index.ts";
import { ImageRegistryService } from "../infrastructure/registry/index.ts";
import {
  buildConfigMap,
  type KubeClient,
} from "../infrastructure/kubernetes/index.ts";
import type {
  ImageBuild,
  ImageBuildStatus,
  RebuildAllStatus,
  RebuildAllTriggerResponse,
} from "../schemas/image.ts";
import { NotFoundError, SandboxError } from "../shared/errors.ts";
import { config, isMock } from "../shared/lib/config.ts";
import { createChildLogger } from "../shared/lib/logger.ts";

const log = createChildLogger("base-image-builder");

const COMPONENT_LABEL = "base-image-build";
const CONFIGMAP_PREFIX = "base-image-ctx";
const JOB_PREFIX = "base-image-build";

const REBUILD_POLL_INTERVAL_MS = 5_000;
const REBUILD_BUILD_TIMEOUT_MS = 30 * 60_000;

export class BaseImageBuilder {
  private rebuildAllState: RebuildAllStatus | null = null;

  constructor(
    private kubeClient: KubeClient,
    private imageBuilder: ImageBuilder,
  ) {}

  /**
   * Rebuild every buildable image, respecting `base` dependencies:
   * each dependency layer is built sequentially, images within a
   * layer in parallel. Returns immediately; progress is tracked
   * in-memory and exposed via getRebuildAllStatus().
   */
  async triggerRebuildAll(): Promise<RebuildAllTriggerResponse> {
    if (this.rebuildAllState?.active) {
      throw new SandboxError(
        "A rebuild-all run is already in progress",
        "CONFLICT",
        409,
      );
    }

    const images = await discoverImages(config.sandbox.imagesDirectory);
    const buildable = images.filter((img) => img.hasDockerfile);
    if (buildable.length === 0) {
      throw new SandboxError(
        "No buildable images found",
        "VALIDATION_ERROR",
        400,
      );
    }

    const layers = this.resolveBuildLayers(buildable);

    this.rebuildAllState = {
      active: true,
      startedAt: Date.now(),
      images: buildable.map((img) => ({
        imageId: img.id,
        status: "pending",
      })),
    };

    const order = layers.map((layer) => layer.map((img) => img.id));
    setImmediate(() => {
      this.runRebuildAll(layers).catch((error) => {
        log.error({ error }, "Rebuild-all run crashed");
        this.finishRebuildAll();
      });
    });

    return {
      order,
      message: `Rebuilding ${buildable.length} images in ${layers.length} stage(s)`,
    };
  }

  getRebuildAllStatus(): RebuildAllStatus | null {
    return this.rebuildAllState;
  }

  /**
   * Group images into dependency layers (Kahn levels): layer 0 has no
   * buildable parent, layer N depends only on layers < N. Images whose
   * base is outside the buildable set (e.g. node:22-slim) are roots.
   */
  private resolveBuildLayers(images: ImageDefinition[]): ImageDefinition[][] {
    const byId = new Map(images.map((img) => [img.id, img]));
    const placed = new Set<string>();
    const layers: ImageDefinition[][] = [];
    let remaining = [...images];

    while (remaining.length > 0) {
      const layer = remaining.filter(
        (img) => !img.base || !byId.has(img.base) || placed.has(img.base),
      );
      if (layer.length === 0) {
        // Dependency cycle — build the rest in one parallel layer
        log.warn(
          { images: remaining.map((i) => i.id) },
          "Dependency cycle detected in image bases",
        );
        layers.push(remaining);
        break;
      }
      for (const img of layer) placed.add(img.id);
      remaining = remaining.filter((img) => !placed.has(img.id));
      layers.push(layer);
    }

    return layers;
  }

  private async runRebuildAll(layers: ImageDefinition[][]): Promise<void> {
    const failed = new Set<string>();

    for (const layer of layers) {
      await Promise.all(
        layer.map(async (img) => {
          if (img.base && failed.has(img.base)) {
            failed.add(img.id);
            this.setRebuildImageStatus(
              img.id,
              "skipped",
              `Base image '${img.base}' failed to build`,
            );
            return;
          }

          try {
            this.setRebuildImageStatus(img.id, "building");
            await this.triggerBuild(img.id);
            const result = await this.waitForBuild(img.id);
            if (result.status === "succeeded") {
              this.setRebuildImageStatus(img.id, "succeeded");
            } else {
              failed.add(img.id);
              this.setRebuildImageStatus(img.id, "failed", result.error);
            }
          } catch (error) {
            failed.add(img.id);
            this.setRebuildImageStatus(
              img.id,
              "failed",
              error instanceof Error ? error.message : String(error),
            );
          }
        }),
      );
    }

    this.finishRebuildAll();
    log.info(
      { failed: [...failed] },
      failed.size === 0
        ? "Rebuild-all completed successfully"
        : "Rebuild-all completed with failures",
    );
  }

  private async waitForBuild(
    imageId: string,
  ): Promise<{ status: "succeeded" | "failed"; error?: string }> {
    if (isMock()) return { status: "succeeded" };

    const deadline = Date.now() + REBUILD_BUILD_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await Bun.sleep(REBUILD_POLL_INTERVAL_MS);
      const build = await this.getBuildStatus(imageId);
      if (build.status === "succeeded") return { status: "succeeded" };
      if (build.status === "failed") {
        return { status: "failed", error: build.error };
      }
    }
    return { status: "failed", error: "Build timed out" };
  }

  private setRebuildImageStatus(
    imageId: string,
    status: RebuildAllStatus["images"][number]["status"],
    error?: string,
  ): void {
    const entry = this.rebuildAllState?.images.find(
      (img) => img.imageId === imageId,
    );
    if (!entry) return;
    entry.status = status;
    entry.error = error;
  }

  private finishRebuildAll(): void {
    if (!this.rebuildAllState) return;
    this.rebuildAllState.active = false;
    this.rebuildAllState.finishedAt = Date.now();
  }

  async triggerBuild(imageId: string): Promise<{
    imageId: string;
    jobName: string;
    status: "building";
    message: string;
  }> {
    const imagesDir = config.sandbox.imagesDirectory;
    const image = await getImageById(imagesDir, imageId);
    if (!image) {
      throw new NotFoundError("Image", imageId);
    }

    if (!image.hasDockerfile) {
      throw new SandboxError(
        `Image '${imageId}' has no Dockerfile`,
        "VALIDATION_ERROR",
        400,
      );
    }

    /* ── Check for active build via K8s job ────────────── */
    const activeJob = await this.findActiveJob(imageId);
    if (activeJob) {
      throw new SandboxError(
        `Build already in progress for '${imageId}'`,
        "CONFLICT",
        409,
      );
    }

    const ts = Date.now();
    const configMapName = `${CONFIGMAP_PREFIX}-${imageId}-${ts}`;
    const jobName = `${JOB_PREFIX}-${imageId}-${ts}`;
    const namespace = config.kubernetes.systemNamespace;
    const registryUrl = config.kubernetes.registryUrl;
    const destination = `${registryUrl}/${imageId}:latest`;
    const cacheRepo = config.imageBuilder.cacheRepo || `${registryUrl}/cache`;

    /* ── 1. Collect all build context files ──────────────── */
    const { data: contextData, items } = await this.collectContextFiles(
      image.path,
    );

    log.info({ imageId, files: items.length }, "Collected build context files");

    /* ── 2. Create ConfigMap with items[].path mapping ──── */
    const labels = {
      "atelier.dev/component": COMPONENT_LABEL,
      "atelier.dev/image": imageId,
    };
    const configMap = buildConfigMap(
      configMapName,
      contextData,
      namespace,
      labels,
    );

    await this.kubeClient.createResource(configMap, namespace);
    log.info({ configMapName, namespace }, "Created build context ConfigMap");

    /* ── 3. Dispatch the build via the configured builder ─ */
    const job = this.imageBuilder.buildJob({
      jobName,
      imageId,
      destinationImage: destination,
      namespace,
      configMapName,
      configMapItems: items,
      cacheRepo,
      labels,
    });

    await this.kubeClient.createResource(job, namespace);
    log.info(
      { jobName, destination, namespace, builder: this.imageBuilder.kind },
      "Created base image build Job",
    );

    return {
      imageId,
      jobName,
      status: "building",
      message: `Build started for '${imageId}'`,
    };
  }

  async getBuildStatus(imageId: string): Promise<ImageBuild> {
    if (isMock()) {
      return { imageId, status: "idle" };
    }

    const namespace = config.kubernetes.systemNamespace;
    const jobs = await this.kubeClient.listJobs(
      `atelier.dev/component=${COMPONENT_LABEL},atelier.dev/image=${imageId}`,
      namespace,
    );

    /* ── Find the most recent job ──────────────────────── */
    const latest = this.latestJob(jobs);

    if (latest) {
      const status = this.deriveJobStatus(latest.status);
      const build: ImageBuild = {
        imageId,
        status,
        jobName: latest.metadata?.name,
        startedAt: latest.metadata?.creationTimestamp
          ? new Date(latest.metadata.creationTimestamp).getTime()
          : undefined,
        finishedAt: latest.status?.completionTime
          ? new Date(latest.status.completionTime).getTime()
          : undefined,
      };

      if (status === "failed") {
        build.error = await this.tryGetLogs(imageId);
      }

      return build;
    }

    /* ── No job found — check if image exists in Zot ──── */
    const exists = await ImageRegistryService.imageExists(imageId);
    return {
      imageId,
      status: exists === true ? "succeeded" : "idle",
    };
  }

  async cancelBuild(imageId: string): Promise<void> {
    const namespace = config.kubernetes.systemNamespace;
    const labelSelector = `atelier.dev/component=${COMPONENT_LABEL},atelier.dev/image=${imageId}`;

    /* ── Delete jobs ──────────────────────────────────── */
    const jobs = await this.kubeClient.listJobs(labelSelector, namespace);
    for (const job of jobs) {
      const jobName = job.metadata?.name;
      if (!jobName) continue;

      try {
        await this.kubeClient.deleteResource("Job", jobName, namespace);
      } catch {
        log.warn({ jobName }, "Failed to delete build Job");
      }
    }

    /* ── Clean up associated resources (ConfigMaps, Pods) */
    try {
      await this.kubeClient.deleteLabeledResources(labelSelector, namespace);
    } catch {
      log.warn({ imageId }, "Failed to clean up build resources");
    }

    log.info({ imageId }, "Cancelled and cleaned up build");
  }

  async listBuilds(): Promise<ImageBuild[]> {
    const images = await discoverImages(config.sandbox.imagesDirectory);
    const buildable = images.filter((img) => img.hasDockerfile);
    return Promise.all(buildable.map((img) => this.getBuildStatus(img.id)));
  }

  private async findActiveJob(imageId: string): Promise<string | null> {
    if (isMock()) return null;

    const namespace = config.kubernetes.systemNamespace;
    const jobs = await this.kubeClient.listJobs(
      `atelier.dev/component=${COMPONENT_LABEL},atelier.dev/image=${imageId}`,
      namespace,
    );

    for (const job of jobs) {
      const s = job.status;
      if ((s?.succeeded ?? 0) === 0 && (s?.failed ?? 0) === 0) {
        return job.metadata?.name ?? null;
      }
    }

    return null;
  }

  private deriveJobStatus(status?: {
    succeeded?: number;
    failed?: number;
    active?: number;
  }): ImageBuildStatus {
    if (!status) return "building";
    if ((status.succeeded ?? 0) > 0) return "succeeded";
    if ((status.failed ?? 0) > 0) return "failed";
    return "building";
  }

  private latestJob<
    T extends {
      metadata?: { creationTimestamp?: string };
    },
  >(jobs: T[]): T | undefined {
    if (jobs.length === 0) return undefined;
    return jobs.sort((a, b) => {
      const tA = a.metadata?.creationTimestamp ?? "";
      const tB = b.metadata?.creationTimestamp ?? "";
      return tB.localeCompare(tA);
    })[0];
  }

  /**
   * Collect build context files and encode paths for ConfigMap compatibility.
   * ConfigMap keys cannot contain '/' — we encode them and use items[].path
   * to restore the original directory structure when mounted.
   *
   * Also rewrites FROM atelier/* → FROM {registryUrl}/* for Zot-internal refs.
   */
  private async collectContextFiles(imagePath: string): Promise<{
    data: Record<string, string>;
    items: Array<{ key: string; path: string }>;
  }> {
    const data: Record<string, string> = {};
    const items: Array<{ key: string; path: string }> = [];
    const registryUrl = config.kubernetes.registryUrl;

    const walk = async (dir: string) => {
      const entries = await readdir(dir);
      for (const entry of entries) {
        if (entry === "image.json") continue;

        const fullPath = join(dir, entry);
        const stats = await stat(fullPath);

        if (stats.isDirectory()) {
          await walk(fullPath);
        } else {
          const relPath = relative(imagePath, fullPath);
          let content = await readFile(fullPath, "utf-8");

          /* Rewrite FROM lines to use Zot registry */
          if (relPath === "Dockerfile") {
            content = content.replace(
              /^FROM\s+atelier\/([^:\s]+)/gm,
              `FROM ${registryUrl}/$1`,
            );
            content = content.replace(
              /--from=atelier\/([^:\s]+)/g,
              `--from=${registryUrl}/$1`,
            );
          }

          // ConfigMap keys must match [-._a-zA-Z0-9]+
          const encodedKey = relPath.replaceAll("/", "__");
          data[encodedKey] = content;
          items.push({ key: encodedKey, path: relPath });
        }
      }
    };

    await walk(imagePath);
    return { data, items };
  }

  private async tryGetLogs(imageId: string): Promise<string | undefined> {
    try {
      const namespace = config.kubernetes.systemNamespace;
      const pods = await this.kubeClient.listPods(
        `atelier.dev/image=${imageId},atelier.dev/component=${COMPONENT_LABEL}`,
        namespace,
      );

      if (pods.length === 0) return undefined;

      const podName = pods[0]?.metadata?.name;
      if (!podName) return undefined;

      const logs = await this.kubeClient.getPodLogs(podName, namespace);
      return logs.length > 2000 ? logs.slice(-2000) : logs;
    } catch {
      return undefined;
    }
  }
}
