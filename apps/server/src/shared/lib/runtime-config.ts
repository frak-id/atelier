/**
 * Live view of the runtime-tunable image registry + builder config.
 *
 * These values used to be read straight off the frozen `config` singleton
 * (env/file, resolved once at boot). They now live in the DB-backed config
 * plane (`ServerConfigService`) so an operator can edit them from the console
 * and have every spawn/prebuild/toolset/build pick up the change immediately.
 *
 * `bindRuntimeConfig` is called once at bootstrap. Until then (and in unit
 * tests that never bootstrap the control container) these fall back to the
 * static `config` so nothing depends on wiring order. The `ServerConfigService`
 * itself already layers env-lock over the store, so reading through it also
 * honors any Helm/operator env override transparently.
 */
import type { ServerConfigService } from "../../control/modules/server-config/index.ts";
import { config } from "./config.ts";

let service: ServerConfigService | undefined;

export function bindRuntimeConfig(svc: ServerConfigService): void {
  service = svc;
}

/** OCI registry host for sandbox/prebuild/toolset images. */
export function registryUrl(): string {
  return service
    ? service.get("kubernetes.registryUrl")
    : config.kubernetes.registryUrl;
}

/** Base image used for a sandbox/toolset build when the request names none. */
export function defaultImage(): string {
  return service
    ? service.get("sandbox.defaultImage")
    : config.sandbox.defaultImage;
}

/** Optional private npm registry injected into sandboxes ("" = disabled). */
export function npmRegistryUrl(): string {
  return service
    ? service.get("kubernetes.npmRegistryUrl")
    : config.kubernetes.npmRegistryUrl;
}

/** Default sandbox PVC size (K8s quantity) when a request sets no disk size. */
export function defaultVolumeSize(): string {
  return service
    ? service.get("kubernetes.defaultVolumeSize")
    : config.kubernetes.defaultVolumeSize;
}

/** StorageClass for sandbox PVCs ("" = cluster default). */
export function storageClass(): string {
  return service
    ? service.get("kubernetes.storageClass")
    : config.kubernetes.storageClass;
}

/** VolumeSnapshotClass for prebuild snapshots ("" = cluster default). */
export function volumeSnapshotClass(): string {
  return service
    ? service.get("kubernetes.volumeSnapshotClass")
    : config.kubernetes.volumeSnapshotClass;
}

export interface ResolvedImageBuilder {
  kind: "docker" | "kaniko" | "buildkit";
  image: string;
  endpoint: string;
  dockerHost: string;
  platform: string;
  cacheRepo: string;
  insecureRegistry: boolean;
  tls: { secretName: string; serverName: string };
}

/** The current image-builder config (backend selection + build knobs). Read
 * fresh per build so a console edit to the builder kind/endpoint/etc. applies
 * to the next build without a restart. */
export function imageBuilderConfig(): ResolvedImageBuilder {
  if (!service) return config.imageBuilder;
  return {
    kind: service.get("imageBuilder.kind"),
    image: service.get("imageBuilder.image"),
    endpoint: service.get("imageBuilder.endpoint"),
    dockerHost: service.get("imageBuilder.dockerHost"),
    platform: service.get("imageBuilder.platform"),
    cacheRepo: service.get("imageBuilder.cacheRepo"),
    insecureRegistry: service.get("imageBuilder.insecureRegistry"),
    tls: {
      secretName: service.get("imageBuilder.tls.secretName"),
      serverName: service.get("imageBuilder.tls.serverName"),
    },
  };
}
