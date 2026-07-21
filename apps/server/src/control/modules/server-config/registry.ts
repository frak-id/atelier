/**
 * The server-config registry: the single source of truth for every runtime-
 * tunable server setting (atelier-v2 server config plane). Each entry declares
 * its type, a safe hard-coded default, an env var it can be preseeded from,
 * and a validator — so the store never has to guess a value's shape and the
 * API/CLI/MCP/console surfaces all render from one description.
 *
 * Values live in the `settings` table (key → JSON). This registry is the only
 * place that knows what a key *means*; the repository is dumb key/value.
 */

import { ValidationError } from "../../../shared/errors.ts";

export type ConfigValue = boolean | number | string;

export interface ConfigDef<T extends ConfigValue> {
  key: string;
  type: T extends boolean ? "boolean" : T extends number ? "number" : "string";
  label: string;
  description: string;
  /** For string keys constrained to a fixed set — the console renders a
   * select instead of a free-text input, and `validate` rejects anything
   * outside the set. */
  options?: readonly string[];
  /** Env var this key can be locked by. When the env var is set (non-empty),
   * its value is authoritative and live, and the stored/console value is
   * read-only (see `ServerConfigService`). Otherwise it is just a one-time
   * default source. */
  envVar: string;
  default: T;
  /** Parse a raw env string into a typed value (throws on garbage). */
  parseEnv: (raw: string) => T;
  /** Validate an untyped value (from HTTP/MCP/CLI) into the typed value. */
  validate: (value: unknown) => T;
}

function parseBoolEnv(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new ValidationError(`expected a boolean, got "${raw}"`);
}

function validateBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return parseBoolEnv(value);
  throw new ValidationError(`expected a boolean, got ${typeof value}`);
}

function nonNegativeInt(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
    throw new ValidationError(
      `expected a non-negative integer, got "${value}"`,
    );
  }
  return n;
}

/** Any string, including empty (the shape most optional overrides take — an
 * empty value means "unset, fall back to the backend default"). */
function optionalString(value: unknown): string {
  if (typeof value !== "string") {
    throw new ValidationError(`expected a string, got ${typeof value}`);
  }
  return value.trim();
}

/** A non-empty string (for keys that must always resolve to something). */
function requiredString(value: unknown): string {
  const s = optionalString(value);
  if (s === "") throw new ValidationError("expected a non-empty string");
  return s;
}

/** A positive integer (>= 1) — for pool sizes and the like. */
function positiveInt(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
    throw new ValidationError(`expected an integer >= 1, got "${value}"`);
  }
  return n;
}

/** Empty (disabled) or a parseable absolute URL — for optional upstream URLs. */
function optionalUrl(value: unknown): string {
  const s = optionalString(value);
  if (s === "") return "";
  try {
    new URL(s);
  } catch {
    throw new ValidationError(`invalid URL "${s}"`);
  }
  return s;
}

/** A Kubernetes resource quantity, e.g. `10Gi` / `512Mi` / `2G`. */
function k8sQuantity(value: unknown): string {
  const s = requiredString(value);
  if (!/^\d+(\.\d+)?(Ki|Mi|Gi|Ti|Pi|Ei|K|M|G|T|P|E)?$/.test(s)) {
    throw new ValidationError(
      `invalid quantity "${s}": expected a K8s size like 10Gi or 512Mi`,
    );
  }
  return s;
}

/** An OCI registry host: `host[:port][/path]`, no scheme, no whitespace — the
 * push/pull destination is concatenated as `${registryUrl}/${name}`, so a
 * stray scheme or trailing slash would produce a malformed ref. */
function registryHost(value: unknown): string {
  const s = requiredString(value);
  if (/\s/.test(s) || s.includes("://")) {
    throw new ValidationError(
      `invalid registry host "${s}": use host[:port] with no scheme (e.g. ` +
        `zot.atelier-system.svc:5000)`,
    );
  }
  return s.replace(/\/+$/, "");
}

/** Build a validator constrained to a fixed set of string literals. */
function oneOf<T extends string>(options: readonly T[]): (v: unknown) => T {
  return (value: unknown): T => {
    const s = optionalString(value);
    if (!options.includes(s as T)) {
      throw new ValidationError(
        `expected one of ${options.join(", ")}, got "${s}"`,
      );
    }
    return s as T;
  };
}

const builderKinds = ["docker", "kaniko", "buildkit"] as const;
const validateBuilderKind = oneOf(builderKinds);

/**
 * The two first config keys (see request): prebuild git tracking + the
 * retention window for the snapshots it produces.
 */
export const CONFIG_REGISTRY = {
  "prebuild.gitTracking": {
    key: "prebuild.gitTracking",
    type: "boolean",
    label: "Prebuild git tracking",
    description:
      "Monitor the git HEAD of repositories baked into a prebuild and " +
      "rebuild the prebuild automatically when upstream moves. On by " +
      "default; disable to stop automatic rebuilds (they cost compute).",
    envVar: "ATELIER_PREBUILD_GIT_TRACKING",
    default: true,
    parseEnv: parseBoolEnv,
    validate: validateBool,
  } satisfies ConfigDef<boolean>,
  "prebuild.pruneKeep": {
    key: "prebuild.pruneKeep",
    type: "number",
    label: "Prebuild retention",
    description:
      "How many superseded, unused prebuild snapshots to keep per prebuild " +
      "lineage (history for spawning older versions). 0 auto-prunes every " +
      "unused snapshot; 3 keeps the last three. In-use snapshots are never " +
      "pruned.",
    envVar: "ATELIER_PREBUILD_PRUNE_KEEP",
    default: 3,
    parseEnv: nonNegativeInt,
    validate: nonNegativeInt,
  } satisfies ConfigDef<number>,

  // ── image registry + builder (the "where/how images are stored & built"
  //    plane). registryUrl is read on every spawn/prebuild/toolset op; the
  //    imageBuilder.* keys are re-read per build (backend is rebuilt each
  //    build) so console edits apply live. ──────────────────────────────
  "kubernetes.registryUrl": {
    key: "kubernetes.registryUrl",
    type: "string",
    label: "Image registry URL",
    description:
      "OCI registry host[:port] where sandbox and prebuild images live " +
      "(the bundled Zot by default). No scheme — it is concatenated as " +
      "`<registry>/<image>`. Changing it points every spawn, prebuild, and " +
      "toolset push/pull at the new registry.",
    envVar: "ATELIER_K8S_REGISTRY_URL",
    default: "zot.atelier-system.svc:5000",
    parseEnv: registryHost,
    validate: registryHost,
  } satisfies ConfigDef<string>,
  "imageBuilder.kind": {
    key: "imageBuilder.kind",
    type: "string",
    options: builderKinds,
    label: "Image builder",
    description:
      "Which build backend to use: docker (shell out to a Docker daemon), " +
      "kaniko (a K8s Job, no daemon), or buildkit (dispatch to an existing " +
      "buildkitd). buildkit requires an endpoint below.",
    envVar: "ATELIER_IMAGE_BUILDER_KIND",
    default: "docker",
    parseEnv: validateBuilderKind,
    validate: validateBuilderKind,
  } satisfies ConfigDef<string>,
  "imageBuilder.image": {
    key: "imageBuilder.image",
    type: "string",
    label: "Builder image override",
    description:
      "Override the builder image (kaniko executor / buildkit buildctl " +
      "client). Empty uses the sensible per-kind default. Ignored for the " +
      "docker backend.",
    envVar: "ATELIER_IMAGE_BUILDER_IMAGE",
    default: "",
    parseEnv: optionalString,
    validate: optionalString,
  } satisfies ConfigDef<string>,
  "imageBuilder.endpoint": {
    key: "imageBuilder.endpoint",
    type: "string",
    label: "BuildKit endpoint",
    description:
      "Address of an existing buildkitd daemon (e.g. " +
      "tcp://buildkitd.buildkit.svc:1234). Required when the builder is " +
      "buildkit; ignored otherwise.",
    envVar: "ATELIER_IMAGE_BUILDER_ENDPOINT",
    default: "",
    parseEnv: optionalString,
    validate: optionalString,
  } satisfies ConfigDef<string>,
  "imageBuilder.dockerHost": {
    key: "imageBuilder.dockerHost",
    type: "string",
    label: "Docker host",
    description:
      "Docker daemon URL (e.g. tcp://docker-host:2375) for the docker " +
      "backend. Empty inherits the process DOCKER_HOST / local socket. " +
      "Ignored for other backends.",
    envVar: "ATELIER_IMAGE_BUILDER_DOCKER_HOST",
    default: "",
    parseEnv: optionalString,
    validate: optionalString,
  } satisfies ConfigDef<string>,
  "imageBuilder.platform": {
    key: "imageBuilder.platform",
    type: "string",
    label: "Build platform",
    description:
      "Target build platform for every backend (e.g. linux/amd64, " +
      "linux/arm64).",
    envVar: "ATELIER_IMAGE_BUILDER_PLATFORM",
    default: "linux/amd64",
    parseEnv: requiredString,
    validate: requiredString,
  } satisfies ConfigDef<string>,
  "imageBuilder.cacheRepo": {
    key: "imageBuilder.cacheRepo",
    type: "string",
    label: "Build cache repo",
    description:
      "Cache repository used by the builder. Empty defaults to " +
      "`<registry>/cache`.",
    envVar: "ATELIER_IMAGE_BUILDER_CACHE_REPO",
    default: "",
    parseEnv: optionalString,
    validate: optionalString,
  } satisfies ConfigDef<string>,
  "imageBuilder.insecureRegistry": {
    key: "imageBuilder.insecureRegistry",
    type: "boolean",
    label: "Insecure registry",
    description:
      "Treat the destination/cache registry as insecure (HTTP / self-signed). " +
      "On by default because the bundled Zot runs without TLS; turn off for a " +
      "TLS registry.",
    envVar: "ATELIER_IMAGE_BUILDER_INSECURE_REGISTRY",
    default: true,
    parseEnv: parseBoolEnv,
    validate: validateBool,
  } satisfies ConfigDef<boolean>,
  "imageBuilder.tls.secretName": {
    key: "imageBuilder.tls.secretName",
    type: "string",
    label: "BuildKit TLS secret",
    description:
      "Name of a K8s Secret (ca.crt/tls.crt/tls.key) for mTLS to buildkitd. " +
      "Empty talks plaintext. Only relevant for the buildkit backend.",
    envVar: "ATELIER_IMAGE_BUILDER_TLS_SECRET_NAME",
    default: "",
    parseEnv: optionalString,
    validate: optionalString,
  } satisfies ConfigDef<string>,
  "imageBuilder.tls.serverName": {
    key: "imageBuilder.tls.serverName",
    type: "string",
    label: "BuildKit TLS server name",
    description:
      "Override the server name used for buildkitd TLS hostname verification " +
      "(--tlsservername). Only relevant for the buildkit backend.",
    envVar: "ATELIER_IMAGE_BUILDER_TLS_SERVER_NAME",
    default: "",
    parseEnv: optionalString,
    validate: optionalString,
  } satisfies ConfigDef<string>,

  // ── sandbox defaults + infra selection (read per spawn/prebuild/snapshot,
  //    so console edits apply to the next sandbox). ─────────────────────────
  "sandbox.defaultImage": {
    key: "sandbox.defaultImage",
    type: "string",
    label: "Default sandbox image",
    description:
      "Base image used for a new sandbox (or toolset build) when the request " +
      "does not name one. A built image / seed name (e.g. dev-base) or a " +
      "registered external ref.",
    envVar: "ATELIER_DEFAULT_IMAGE",
    default: "dev-base",
    parseEnv: requiredString,
    validate: requiredString,
  } satisfies ConfigDef<string>,
  "kubernetes.npmRegistryUrl": {
    key: "kubernetes.npmRegistryUrl",
    type: "string",
    label: "npm registry URL",
    description:
      "Optional private npm registry (Verdaccio/Nexus/Artifactory) injected " +
      "into every sandbox's npm/bun/yarn config. Empty leaves sandboxes on " +
      "the public npm registry. Must be a full URL (https://…).",
    envVar: "ATELIER_NPM_REGISTRY_URL",
    default: "",
    parseEnv: optionalUrl,
    validate: optionalUrl,
  } satisfies ConfigDef<string>,
  "kubernetes.defaultVolumeSize": {
    key: "kubernetes.defaultVolumeSize",
    type: "string",
    label: "Default volume size",
    description:
      "Default sandbox PVC size (K8s quantity, e.g. 10Gi) when a request " +
      "does not set an explicit disk size.",
    envVar: "ATELIER_K8S_DEFAULT_VOLUME_SIZE",
    default: "10Gi",
    parseEnv: k8sQuantity,
    validate: k8sQuantity,
  } satisfies ConfigDef<string>,
  "kubernetes.storageClass": {
    key: "kubernetes.storageClass",
    type: "string",
    label: "Storage class",
    description:
      "StorageClass for sandbox PVCs. Empty uses the cluster default. Must " +
      "support Block volumes + block-volume VolumeSnapshots (e.g. " +
      "topolvm-thin).",
    envVar: "ATELIER_K8S_STORAGE_CLASS",
    default: "",
    parseEnv: optionalString,
    validate: optionalString,
  } satisfies ConfigDef<string>,
  "kubernetes.volumeSnapshotClass": {
    key: "kubernetes.volumeSnapshotClass",
    type: "string",
    label: "Volume snapshot class",
    description:
      "VolumeSnapshotClass for prebuild snapshots (required for instant " +
      "clone-from-prebuild). Empty uses the cluster default.",
    envVar: "ATELIER_K8S_VOLUME_SNAPSHOT_CLASS",
    default: "",
    parseEnv: optionalString,
    validate: optionalString,
  } satisfies ConfigDef<string>,
  "jobs.concurrency": {
    key: "jobs.concurrency",
    type: "number",
    label: "Build job concurrency",
    description:
      "How many pooled build jobs (prebuild bake, toolset build/capture) may " +
      "run at once. Extra dispatches queue. Sandbox lifecycle jobs bypass " +
      "this limit.",
    envVar: "ATELIER_JOBS_CONCURRENCY",
    default: 4,
    parseEnv: positiveInt,
    validate: positiveInt,
  } satisfies ConfigDef<number>,
} as const;

export type ConfigKey = keyof typeof CONFIG_REGISTRY;

/** The typed value each key resolves to. */
export interface ConfigValues {
  "prebuild.gitTracking": boolean;
  "prebuild.pruneKeep": number;
  "kubernetes.registryUrl": string;
  "imageBuilder.kind": "docker" | "kaniko" | "buildkit";
  "imageBuilder.image": string;
  "imageBuilder.endpoint": string;
  "imageBuilder.dockerHost": string;
  "imageBuilder.platform": string;
  "imageBuilder.cacheRepo": string;
  "imageBuilder.insecureRegistry": boolean;
  "imageBuilder.tls.secretName": string;
  "imageBuilder.tls.serverName": string;
  "sandbox.defaultImage": string;
  "kubernetes.npmRegistryUrl": string;
  "kubernetes.defaultVolumeSize": string;
  "kubernetes.storageClass": string;
  "kubernetes.volumeSnapshotClass": string;
  "jobs.concurrency": number;
}

export const CONFIG_DEFS = Object.values(
  CONFIG_REGISTRY,
) as ConfigDef<ConfigValue>[];

export function isConfigKey(key: string): key is ConfigKey {
  return key in CONFIG_REGISTRY;
}

/** Keys that live ONLY in the config plane (DB/env) with no counterpart in the
 * static AtelierConfig file. Everything else mirrors a file config path whose
 * dotted name equals the plane key (e.g. `kubernetes.registryUrl`). */
const PLANE_ONLY_KEYS = new Set<ConfigKey>([
  "prebuild.gitTracking",
  "prebuild.pruneKeep",
]);

/** The AtelierConfig dotted path a key mirrors (for reading the operator's
 * file/env value + detecting whether they set it), or undefined for plane-only
 * keys. By construction the plane key IS the config path for mirrored keys. */
export function configPathFor(key: ConfigKey): string | undefined {
  return PLANE_ONLY_KEYS.has(key) ? undefined : key;
}

export function configDef(key: ConfigKey): ConfigDef<ConfigValue> {
  return CONFIG_REGISTRY[key] as ConfigDef<ConfigValue>;
}
