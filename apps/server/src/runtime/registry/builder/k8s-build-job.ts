/**
 * Shared driver for the cluster-native image builders (kaniko, buildkit).
 * Both run the build as a one-shot Kubernetes Job in `kubeClient.namespace`
 * and differ ONLY in the build container they run — everything else (getting
 * the context into the cluster, watching the Job, streaming logs, reading the
 * pushed digest back, cleanup) is identical and lives here.
 *
 * Context delivery — the hard part on a stock k3s node with no shared
 * filesystem or object store — is done WITHOUT any external dependency: the
 * prepared context (seed dir / unpacked zip / synthetic single-Dockerfile
 * dir, with the service-rewritten Dockerfile written in as `./Dockerfile`) is
 * `tar`-gzipped, base64'd into a ConfigMap, and an init container untars it
 * into an `emptyDir` the build container then reads. Seed contexts are a few
 * KB; a hard cap (`MAX_CONTEXT_BYTES`) rejects oversized uploads with a clear
 * error rather than tripping the API server's ~1MiB object limit.
 *
 * Digest read-back also avoids pod exec: the build container writes the bare
 * pushed digest (`sha256:<hex>`) to `/dev/termination-log`, which Kubernetes
 * surfaces as the container's `state.terminated.message` — read straight off
 * pod status once the Job completes.
 */
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxError } from "../../../shared/errors.ts";
import { isMock } from "../../../shared/lib/config.ts";
import { createChildLogger } from "../../../shared/lib/logger.ts";
import { kubeClient } from "../../kube/index.ts";

const log = createChildLogger("image-builder-k8s");

/** Where the init container unpacks the context and the build container reads. */
export const WORKSPACE_DIR = "/workspace";
/** Where the ConfigMap-delivered context tarball is mounted (read-only). */
const CONTEXT_MOUNT = "/atelier-context";
const CONTEXT_FILE = "context.tar.gz";
/** Tiny, ubiquitous image with `tar` for the unpack init container. */
const UNPACK_IMAGE = "busybox:stable";
/** Build-container name — its terminated message carries the pushed digest. */
const BUILD_CONTAINER = "build";
/**
 * ConfigMaps are capped at ~1MiB by the API server and base64 inflates ~33%,
 * so refuse anything whose encoded size approaches that. Seed contexts are
 * ~10-90KB; only a large zip upload would ever hit this. Exported so the
 * upload/accept path (H7: `v1.routes.ts`) can reject an over-ceiling BYO/zip
 * context synchronously, before a `202`, instead of discovering it here mid-
 * build.
 */
export const MAX_CONTEXT_BYTES = 900_000;

const POD_APPEAR_TIMEOUT_MS = 120_000;
const BUILD_TIMEOUT_MS = 30 * 60_000;
const POLL_INTERVAL_MS = 2_000;

/** The build container both backends inject into the shared Job scaffold. */
export interface BuildContainerSpec {
  image: string;
  command?: string[];
  args: string[];
  env?: { name: string; value: string }[];
  /** Extra volumes (e.g. a buildkit client-TLS secret) merged into the pod. */
  volumes?: unknown[];
  /** Extra mounts for the build container, paired with `volumes`. */
  volumeMounts?: unknown[];
}

export interface KubeBuildJobSpec {
  /** DNS-1123 resource name stem (sanitized + unique) for the Job/ConfigMap. */
  name: string;
  contextDir: string;
  dockerfile: string;
  container: BuildContainerSpec;
}

/** Derive a DNS-1123 Job name from a destination tag + a random suffix. */
export function jobResourceName(tag: string): string {
  const image = tag
    .split("/")
    .pop()
    ?.replace(/[:@].*$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const stem = image ? image.slice(0, 40) : "image";
  return `atelier-build-${stem}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * `tar` the context (with the rewritten Dockerfile) into base64-encoded
 * gzip. P2e: rather than `cp`-ing the whole (potentially ~100MB) context
 * tree just to overwrite one file, `tar` reads directly from `contextDir`
 * excluding the ROOT on-disk `Dockerfile` (`--exclude=./Dockerfile`, anchored
 * so a nested `subdir/Dockerfile` is preserved as ordinary context, matching
 * the old copy-then-overwrite behavior), then a second `tar --append` adds the
 * service-rewritten Dockerfile from a tiny one-file overlay dir — the
 * rewritten content still always wins, without doubling disk I/O.
 */
export async function stageContextTarball(
  contextDir: string,
  dockerfile: string,
): Promise<string> {
  const staging = await mkdtemp(join(tmpdir(), "atelier-image-ctx-"));
  try {
    const tarPath = join(staging, "context.tar");
    const overlayDir = join(staging, "overlay");
    await mkdir(overlayDir);
    // Overwrite any Dockerfile in the context with the service-rewritten one
    // (the backend port's contract: build CONTENT, never the on-disk file).
    await writeFile(join(overlayDir, "Dockerfile"), dockerfile, "utf8");

    const create = Bun.spawnSync(
      ["tar", "cf", tarPath, "--exclude=./Dockerfile", "-C", contextDir, "."],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (create.exitCode !== 0) {
      throw new SandboxError(
        `failed to package build context: ${create.stderr.toString().trim()}`,
        "IMAGE_CONTEXT_PACKAGING_FAILED",
        500,
      );
    }

    const append = Bun.spawnSync(
      ["tar", "rf", tarPath, "-C", overlayDir, "Dockerfile"],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (append.exitCode !== 0) {
      throw new SandboxError(
        `failed to package build context: ${append.stderr.toString().trim()}`,
        "IMAGE_CONTEXT_PACKAGING_FAILED",
        500,
      );
    }

    const proc = Bun.spawn(["gzip", "-c", tarPath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const tar = Buffer.from(await new Response(proc.stdout).arrayBuffer());
    const code = await proc.exited;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new SandboxError(
        `failed to package build context: ${err.trim()}`,
        "IMAGE_CONTEXT_PACKAGING_FAILED",
        500,
      );
    }

    const encoded = tar.toString("base64");
    if (encoded.length > MAX_CONTEXT_BYTES) {
      throw new SandboxError(
        `build context is too large for the cluster-native builder ` +
          `(${Math.round(encoded.length / 1024)}KB encoded > ` +
          `${Math.round(MAX_CONTEXT_BYTES / 1024)}KB). Slim the context or ` +
          `use the docker builder for large uploads.`,
        "IMAGE_CONTEXT_TOO_LARGE",
        413,
      );
    }
    return encoded;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Build the Job manifest that unpacks the context then runs the builder. */
export function buildJobManifest(
  spec: KubeBuildJobSpec,
  configMapName: string,
): Record<string, unknown> {
  const { container } = spec;
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: spec.name,
      labels: { "app.kubernetes.io/managed-by": "atelier-image-builder" },
    },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 300,
      activeDeadlineSeconds: Math.round(BUILD_TIMEOUT_MS / 1000),
      template: {
        metadata: {
          labels: { "app.kubernetes.io/managed-by": "atelier-image-builder" },
        },
        spec: {
          restartPolicy: "Never",
          initContainers: [
            {
              name: "unpack",
              image: UNPACK_IMAGE,
              command: [
                "sh",
                "-c",
                `set -e; mkdir -p ${WORKSPACE_DIR}; ` +
                  `tar xzf ${CONTEXT_MOUNT}/${CONTEXT_FILE} -C ${WORKSPACE_DIR}`,
              ],
              volumeMounts: [
                { name: "context", mountPath: CONTEXT_MOUNT, readOnly: true },
                { name: "workspace", mountPath: WORKSPACE_DIR },
              ],
            },
          ],
          containers: [
            {
              name: BUILD_CONTAINER,
              image: container.image,
              ...(container.command ? { command: container.command } : {}),
              args: container.args,
              ...(container.env ? { env: container.env } : {}),
              terminationMessagePolicy: "File",
              volumeMounts: [
                { name: "workspace", mountPath: WORKSPACE_DIR },
                ...((container.volumeMounts ?? []) as unknown[]),
              ],
            },
          ],
          volumes: [
            {
              name: "context",
              configMap: {
                name: configMapName,
                items: [{ key: CONTEXT_FILE, path: CONTEXT_FILE }],
              },
            },
            { name: "workspace", emptyDir: {} },
            ...((container.volumes ?? []) as unknown[]),
          ],
        },
      },
    },
  };
}

interface PodStatus {
  metadata?: { name?: string };
  status?: {
    phase?: string;
    containerStatuses?: Array<{
      name?: string;
      state?: { terminated?: { message?: string; exitCode?: number } };
    }>;
  };
}

const DIGEST_RE = /sha256:[0-9a-f]{64}/;

/** Pull the pushed digest out of the build container's terminated message. */
export function extractDigest(pod: PodStatus): string | undefined {
  const build = pod.status?.containerStatuses?.find(
    (c) => c.name === BUILD_CONTAINER,
  );
  const message = build?.state?.terminated?.message ?? "";
  return DIGEST_RE.exec(message)?.[0];
}

/**
 * Run the build as a Job and return its pushed digest. Streams the build
 * container's logs to `onLog`, honors `signal` (deletes the Job on abort),
 * and always cleans up the Job + context ConfigMap.
 */
export async function runKubeBuildJob(
  spec: KubeBuildJobSpec,
  onLog: (chunk: string) => void,
  signal: AbortSignal,
): Promise<{ digest: string }> {
  if (isMock()) {
    onLog(`[mock] build job ${spec.name} skipped\n`);
    return { digest: `sha256:${"0".repeat(64)}` };
  }

  const ns = kubeClient.namespace;
  const configMapName = `${spec.name}-ctx`;
  const encoded = await stageContextTarball(spec.contextDir, spec.dockerfile);

  await kubeClient.create(`/api/v1/namespaces/${ns}/configmaps`, {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: configMapName,
      labels: { "app.kubernetes.io/managed-by": "atelier-image-builder" },
    },
    binaryData: { [CONTEXT_FILE]: encoded },
  });

  try {
    onLog(`$ submitting build job ${spec.name}\n`);
    await kubeClient.create(
      `/apis/batch/v1/namespaces/${ns}/jobs`,
      buildJobManifest(spec, configMapName),
    );
    const digest = await watchBuildJob(spec.name, ns, onLog, signal);
    log.info({ job: spec.name, digest }, "image built and pushed");
    return { digest };
  } finally {
    await cleanup(ns, spec.name, configMapName);
  }
}

async function watchBuildJob(
  name: string,
  ns: string,
  onLog: (chunk: string) => void,
  signal: AbortSignal,
): Promise<string> {
  const podName = await waitForPod(name, ns, signal);

  // Stream logs best-effort in the background: the container may still be in
  // `unpack`/`ContainerCreating` when we first try, so retry until it starts.
  let streaming = true;
  let delivered = false;
  let lastLogErr: unknown;
  const relay = (chunk: string) => {
    delivered = true;
    onLog(chunk);
  };
  const logs = (async () => {
    while (streaming && !signal.aborted) {
      try {
        await kubeClient.streamPodLogs(podName, relay, {
          container: BUILD_CONTAINER,
          namespace: ns,
          signal,
        });
        if (delivered) return;
        // Endpoint returned with no output yet (container not producing) —
        // re-attach rather than giving up, or we'd stream nothing at all.
        await Bun.sleep(1_000);
      } catch (err) {
        lastLogErr = err;
        await Bun.sleep(1_000);
      }
    }
  })();

  try {
    const started = Date.now();
    while (Date.now() - started < BUILD_TIMEOUT_MS) {
      if (signal.aborted) throw new Error("image build aborted");
      const pod = await kubeClient.get<PodStatus>(
        `/api/v1/namespaces/${ns}/pods/${podName}`,
      );
      const phase = pod.status?.phase;
      if (phase === "Succeeded") {
        const digest = extractDigest(pod);
        if (!digest) {
          throw new SandboxError(
            `build job ${name} succeeded but wrote no digest`,
            "IMAGE_BUILD_NO_DIGEST",
            500,
          );
        }
        return digest;
      }
      if (phase === "Failed") {
        throw new SandboxError(
          `build job ${name} failed`,
          "IMAGE_BUILD_FAILED",
          500,
        );
      }
      await Bun.sleep(POLL_INTERVAL_MS);
    }
    throw new SandboxError(
      `build job ${name} timed out`,
      "IMAGE_BUILD_TIMEOUT",
      504,
    );
  } finally {
    streaming = false;
    await logs.catch(() => {});
    if (!delivered) {
      log.warn(
        { job: name, pod: podName, err: lastLogErr },
        "build log stream produced no output",
      );
    }
  }
}

async function waitForPod(
  jobName: string,
  ns: string,
  signal: AbortSignal,
): Promise<string> {
  const started = Date.now();
  const selector = encodeURIComponent(`job-name=${jobName}`);
  while (Date.now() - started < POD_APPEAR_TIMEOUT_MS) {
    if (signal.aborted) throw new Error("image build aborted");
    const list = await kubeClient.list<{ items?: PodStatus[] }>(
      `/api/v1/namespaces/${ns}/pods?labelSelector=${selector}`,
    );
    const podName = list.items?.[0]?.metadata?.name;
    if (podName) return podName;
    await Bun.sleep(1_000);
  }
  throw new SandboxError(
    `build job ${jobName} never scheduled a pod`,
    "IMAGE_BUILD_NO_POD",
    500,
  );
}

async function cleanup(
  ns: string,
  jobName: string,
  configMapName: string,
): Promise<void> {
  // Background propagation so the Job's pod is swept too; best-effort — a
  // leaked build resource must never fail the caller's build result.
  await kubeClient
    .delete(
      `/apis/batch/v1/namespaces/${ns}/jobs/${jobName}` +
        "?propagationPolicy=Background",
    )
    .catch((err) => log.warn({ jobName, err }, "build Job cleanup failed"));
  await kubeClient
    .delete(`/api/v1/namespaces/${ns}/configmaps/${configMapName}`)
    .catch((err) =>
      log.warn({ configMapName, err }, "build ConfigMap cleanup failed"),
    );
}
