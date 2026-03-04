import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { getImageById } from "@frak/atelier-shared";
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

type BuildState = {
  imageId: string;
  jobName: string;
  configMapName: string;
  startedAt: number;
  finishedAt?: number;
  error?: string;
};

export class BaseImageBuilder {
  private builds = new Map<string, BuildState>();

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

    const existing = this.builds.get(imageId);
    if (existing) {
      const status = await this.resolveJobStatus(existing);
      if (status === "building") {
        throw new SandboxError(
          `Build already in progress for '${imageId}'`,
          "CONFLICT",
          409,
        );
      }
    }

    const ts = Date.now();
    const configMapName = `${CONFIGMAP_PREFIX}-${imageId}-${ts}`;
    const jobName = `${JOB_PREFIX}-${imageId}-${ts}`;
    const namespace = config.kubernetes.systemNamespace;
    const registryUrl = config.kubernetes.registryUrl;
    const destination = `${registryUrl}/${imageId}:latest`;

    /* ── 1. Collect all build context files ──────────────── */
    const contextFiles = await this.collectContextFiles(image.path);

    log.info(
      { imageId, files: Object.keys(contextFiles).length },
      "Collected build context files",
    );

    /* ── 2. Create ConfigMap with items[].path mapping ──── */
    const labels = {
      "atelier.dev/component": COMPONENT_LABEL,
      "atelier.dev/image": imageId,
    };
    const configMap = buildConfigMap(
      configMapName,
      contextFiles,
      namespace,
      labels,
    );

    const items = Object.keys(contextFiles).map((key) => ({
      key,
      path: key,
    }));

    await this.kubeClient.createResource(configMap, namespace);
    log.info({ configMapName, namespace }, "Created build context ConfigMap");

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

    /* ── 4. Track build state ────────────────────────────── */
    this.builds.set(imageId, {
      imageId,
      jobName,
      configMapName,
      startedAt: ts,
    });

    return {
      imageId,
      jobName,
      status: "building",
      message: `Build started for '${imageId}'`,
    };
  }

  async getBuildStatus(imageId: string): Promise<ImageBuild> {
    const build = this.builds.get(imageId);
    if (!build) {
      return {
        imageId,
        status: "idle",
      };
    }

    const status = await this.resolveJobStatus(build);

    if ((status === "succeeded" || status === "failed") && !build.finishedAt) {
      build.finishedAt = Date.now();
      if (status === "failed") {
        build.error = await this.tryGetLogs(build);
      }
    }

    return {
      imageId,
      status,
      jobName: build.jobName,
      startedAt: build.startedAt,
      finishedAt: build.finishedAt,
      error: build.error,
    };
  }

  async cancelBuild(imageId: string): Promise<void> {
    const build = this.builds.get(imageId);
    if (!build) return;

    const namespace = config.kubernetes.systemNamespace;

    try {
      await this.kubeClient.deleteResource("Job", build.jobName, namespace);
    } catch {
      log.warn({ jobName: build.jobName }, "Failed to delete build Job");
    }

    try {
      await this.kubeClient.deleteResource(
        "ConfigMap",
        build.configMapName,
        namespace,
      );
    } catch {
      log.warn(
        { configMapName: build.configMapName },
        "Failed to delete build ConfigMap",
      );
    }

    this.builds.delete(imageId);
    log.info({ imageId }, "Cancelled and cleaned up build");
  }

  async listBuilds(): Promise<ImageBuild[]> {
    const results: ImageBuild[] = [];
    for (const imageId of this.builds.keys()) {
      results.push(await this.getBuildStatus(imageId));
    }
    return results;
  }

  /** Rewrite FROM atelier/* → FROM {registryUrl}/* for Zot-internal refs. */
  private async collectContextFiles(
    imagePath: string,
  ): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
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

          files[relPath] = content;
        }
      }
    };

    await walk(imagePath);
    return files;
  }

  private async resolveJobStatus(build: BuildState): Promise<ImageBuildStatus> {
    if (isMock()) return "succeeded";

    try {
      const status = await this.kubeClient.getJobStatus(
        build.jobName,
        config.kubernetes.systemNamespace,
      );

      switch (status) {
        case "succeeded":
          return "succeeded";
        case "failed":
          return "failed";
        case "active":
          return "building";
        default:
          return "building";
      }
    } catch {
      return "failed";
    }
  }

  private async tryGetLogs(build: BuildState): Promise<string | undefined> {
    try {
      const namespace = config.kubernetes.systemNamespace;
      const pods = await this.kubeClient.listPods(
        `atelier.dev/image=${build.imageId},atelier.dev/component=${COMPONENT_LABEL}`,
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
