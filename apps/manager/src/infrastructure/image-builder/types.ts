import type { KubeResource } from "../kubernetes/index.ts";

/**
 * Context for a single base-image build dispatch.
 *
 * The build context (Dockerfile + supporting files) is provided as a
 * ConfigMap whose keys map to directory paths via `configMapItems`. The
 * builder is responsible for mounting it appropriately for its tool.
 */
export type BuildContext = {
  /** K8s Job name to use (already namespaced/unique). */
  jobName: string;
  /** Image id (e.g. "dev-base") — used for labels and diagnostics. */
  imageId: string;
  /** Fully-qualified destination image ref (registry/name:tag). */
  destinationImage: string;
  /** Namespace to create the Job in. */
  namespace: string;
  /** ConfigMap containing the build context. */
  configMapName: string;
  /** Maps encoded ConfigMap keys back to their original relative paths. */
  configMapItems: Array<{ key: string; path: string }>;
  /** Repository to use for layer caching (e.g. "<registry>/cache"). */
  cacheRepo: string;
  /** Build arguments forwarded as `--build-arg KEY=VALUE`. */
  buildArgs?: Record<string, string>;
  /** Labels applied to the Job and its pod template. */
  labels: Record<string, string>;
};

/**
 * Strategy for producing a K8s Job that runs an image build.
 *
 * Implementations are stateless — the orchestrator owns dispatch, status
 * polling, log retrieval and cancellation via label selectors. The
 * `BuildContext.labels` are guaranteed to be applied to both the Job and
 * its pod template so those operations keep working regardless of which
 * builder is used.
 */
export interface ImageBuilder {
  /** Identifier of the builder strategy (for logs / diagnostics). */
  readonly kind: string;
  /** Produce the Job KubeResource to dispatch this build. */
  buildJob(ctx: BuildContext): KubeResource;
}
