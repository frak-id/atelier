/**
 * Live view of the config the runtime reads per operation.
 *
 * Infrastructure keys (registry, storage classes, image builder) are file/env
 * only and read straight off the frozen `config`. Operational keys (default
 * image/size/resources, agent image, snapshot retention) live in the DB-backed
 * config plane so an admin can edit them from the console and have the next
 * spawn/prebuild/build pick the change up immediately.
 *
 * The plane is reached through a getter injected at bootstrap
 * (`bindRuntimeConfig`), so this module never imports `control/`. Until it is
 * bound (and in unit tests that never bootstrap the control container) the
 * operational getters fall back to the static `config`.
 */
import type { ConfigValueAt } from "../../config/config.schema.ts";
import { config } from "./config.ts";

/** The operational (plane) keys the runtime reads. */
type PlaneKey =
  | "sandbox.defaultImage"
  | "sandbox.defaultVcpus"
  | "sandbox.defaultMemoryMb"
  | "sandbox.agentImage"
  | "kubernetes.defaultVolumeSize"
  | "snapshot.manualKeep";

export type PlaneGetter = <K extends PlaneKey>(key: K) => ConfigValueAt<K>;

let plane: PlaneGetter | undefined;

export function bindRuntimeConfig(getter: PlaneGetter): void {
  plane = getter;
}

/** OCI registry host for sandbox/prebuild/toolset images. Empty = no external
 * registry (local Docker mode: images live in the local daemon). */
export function registryUrl(): string {
  return config.kubernetes.registryUrl;
}

/** Prefix an image/repo name with the configured registry host, or leave it
 * bare when none is set. A bare tag (`dev-base:latest`, `toolsets/x:y`) is a
 * local-daemon reference the docker builder + backend use without any push or
 * pull; a qualified ref (`<registry>/dev-base:latest`) round-trips through the
 * cluster registry. Every `${registry}/${name}` construction goes through this
 * so local mode never emits a broken registry-prefixed ref. */
export function qualifyImageName(name: string): string {
  const registry = registryUrl();
  return registry ? `${registry}/${name}` : name;
}

/** Base image used for a sandbox/toolset build when the request names none. */
export function defaultImage(): string {
  return plane ? plane("sandbox.defaultImage") : config.sandbox.defaultImage;
}

/** How many manual snapshots a sandbox keeps (older unused ones are
 * deleted when a new one is taken). */
export function snapshotManualKeep(): number {
  return plane ? plane("snapshot.manualKeep") : config.snapshot.manualKeep;
}

/** vCPUs a sandbox gets when its create request omits `resources.vcpus`. */
export function defaultVcpus(): number {
  return plane ? plane("sandbox.defaultVcpus") : config.sandbox.defaultVcpus;
}

/** Guest RAM (MB) a sandbox gets when its create request omits
 * `resources.memoryMb`. */
export function defaultMemoryMb(): number {
  return plane
    ? plane("sandbox.defaultMemoryMb")
    : config.sandbox.defaultMemoryMb;
}

/** In-pod agent image the base seeds bake in via the `AGENT_IMAGE` build-arg
 * (default: the prebuilt public GHCR image, so no in-cluster agent build is
 * needed). Override for air-gapped clusters that mirror it privately. */
export function agentImage(): string {
  return plane ? plane("sandbox.agentImage") : config.sandbox.agentImage;
}

/** Default sandbox PVC size (K8s quantity) when a request sets no disk size. */
export function defaultVolumeSize(): string {
  return plane
    ? plane("kubernetes.defaultVolumeSize")
    : config.kubernetes.defaultVolumeSize;
}

/** StorageClass for sandbox PVCs ("" = cluster default). */
export function storageClass(): string {
  return config.kubernetes.storageClass;
}

/** VolumeSnapshotClass for prebuild snapshots ("" = cluster default). */
export function volumeSnapshotClass(): string {
  return config.kubernetes.volumeSnapshotClass;
}

export interface ResolvedImageBuilder {
  kind: "docker" | "buildkit";
  image: string;
  endpoint: string;
  dockerHost: string;
  platform: string;
  cacheRepo: string;
  insecureRegistry: boolean;
  tls: { secretName: string; serverName: string };
}

/** The current image-builder config (backend selection + build knobs). */
export function imageBuilderConfig(): ResolvedImageBuilder {
  return config.imageBuilder;
}
