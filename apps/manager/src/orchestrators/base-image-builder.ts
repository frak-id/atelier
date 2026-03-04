import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { discoverImages, getImageById } from "@frak/atelier-shared";
import {
  buildBaseImageBuildJob,
  buildConfigMap,
  type KubeClient,
} from "../infrastructure/kubernetes/index.ts";
import type { ImageBuild, ImageBuildStatus } from "../schemas/image.ts";
import { NotFoundError, SandboxError } from "../shared/errors.ts";
import { config, isMock } from "../shared/lib/config.ts";
import { createChildLogger } from "../shared/lib/logger.ts";

const log = createChildLogger("base-image-builder");

const COMPONENT_LABEL = "base-image-build";
const CONFIGMAP_PREFIX = "base-image-ctx";
const JOB_PREFIX = "base-image-build";

export class BaseImageBuilder {
  constructor(private kubeClient: KubeClient) {}

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

    /* ── 3. Create Kaniko build Job ──────────────────────── */
    const job = buildBaseImageBuildJob({
      name: jobName,
      imageId,
      configMapName,
      configMapItems: items,
      destinationImage: destination,
      namespace,
    });

    await this.kubeClient.createResource(job, namespace);
    log.info(
      { jobName, destination, namespace },
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
    const exists = await this.checkImageExists(imageId);
    return {
      imageId,
      status: exists ? "succeeded" : "idle",
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

  /**
   * Check if an image exists in the Zot OCI registry.
   * HEAD /v2/{imageId}/manifests/latest → 200=exists, 404=not found.
   */
  private async checkImageExists(imageId: string): Promise<boolean> {
    if (isMock()) return false;
    try {
      const res = await fetch(
        `http://${config.kubernetes.registryUrl}/v2/${imageId}/manifests/latest`,
        {
          method: "HEAD",
          signal: AbortSignal.timeout(3000),
        },
      );
      return res.ok;
    } catch {
      return false;
    }
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
