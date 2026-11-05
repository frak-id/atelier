/**
 * The server-config registry: what the console needs on top of the config
 * schema for each key shown on the Config page — a label, a description, a
 * validator and the `plane` flag.
 *
 * The TypeBox schema (`config/config.schema.ts`) owns every key's type and
 * default and the env var that sets it; nothing is duplicated here. A key is
 * either:
 *   - `plane: true`  — an operational setting a server admin edits from the
 *     console (stored in the `settings` table, key → JSON), unless the
 *     deployment sets it in the config file/env (then it is locked);
 *   - `plane: false` — infrastructure, set by the deployment (file/env) and
 *     shown read-only.
 */

import { schemaDefaults } from "../../../config/config.loader.ts";
import {
  type ConfigValueAt,
  ENV_VAR_MAPPING,
} from "../../../config/config.schema.ts";
import { ValidationError } from "../../../shared/errors.ts";

export type ConfigValue = boolean | number | string;

/** A registry entry before schema-derived fields are filled in. */
interface ConfigSpec {
  /** true = operational, editable from the console; false = infrastructure,
   * set by the deployment (file/env) and read-only here. */
  plane: boolean;
  label: string;
  description: string;
  /** For string keys constrained to a fixed set — the console renders a
   * select instead of a free-text input, and `validate` rejects anything
   * outside the set. Must match the schema's literal union (see test). */
  options?: readonly string[];
  /** Validate an untyped value (from HTTP/MCP) into the typed value. */
  validate: (value: unknown) => ConfigValue;
}

export interface ConfigDef extends ConfigSpec {
  key: ConfigKey;
  /** Derived from the schema default's type. */
  type: "boolean" | "number" | "string";
  /** Schema default. */
  default: ConfigValue;
  /** The env var that sets this key (from the schema's env mapping). */
  envVar: string;
}

/** Accepts the usual spellings so MCP/HTTP callers can pass "yes"/"off". */
function parseBool(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new ValidationError(`expected a boolean, got "${raw}"`);
}

function validateBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return parseBool(value);
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

/** An integer >= 256 — for guest RAM in MB. */
function memoryMb(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 256) {
    throw new ValidationError(`expected an integer >= 256, got "${value}"`);
  }
  return n;
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
  const s = optionalString(value);
  // Empty is valid and meaningful: "no external registry" (local Docker mode —
  // images live in the local daemon, referenced by bare tag).
  if (s === "") return "";
  if (/\s/.test(s) || s.includes("://")) {
    throw new ValidationError(
      `invalid registry host "${s}": use host[:port] with no scheme (e.g. ` +
        `zot.zot.svc:5000), or empty for local Docker`,
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

const builderKinds = ["docker", "buildkit"] as const;
const validateBuilderKind = oneOf(builderKinds);

const idleModes = ["off", "observe", "enforce"] as const;
const validateIdleMode = oneOf(idleModes);

/** Registry specs keyed by config path (== the schema path). */
const CONFIG_SPECS = {
  "prebuild.gitTracking": {
    plane: true,
    label: "Prebuild git tracking",
    description:
      "Monitor the git HEAD of repositories baked into a prebuild and " +
      "rebuild the prebuild automatically when upstream moves. On by " +
      "default; disable to stop automatic rebuilds (they cost compute).",
    validate: validateBool,
  },
  "prebuild.pruneKeep": {
    plane: true,
    label: "Prebuild retention",
    description:
      "How many superseded, unused prebuild snapshots to keep per prebuild " +
      "lineage (history for spawning older versions). 0 keeps only the " +
      "newest snapshot of each lineage; 3 keeps the last three. In-use " +
      "snapshots are never pruned.",
    validate: nonNegativeInt,
  },
  "snapshot.manualKeep": {
    plane: true,
    label: "Manual snapshot retention",
    description:
      "How many manual snapshots to keep per sandbox. Taking a new one " +
      "deletes the oldest beyond this count; a snapshot another sandbox " +
      "boots from is never deleted.",
    validate: positiveInt,
  },
  "kubernetes.registryUrl": {
    plane: false,
    label: "Image registry URL",
    description:
      "OCI registry host[:port] where sandbox and prebuild images live. No " +
      "scheme — it is concatenated as `<registry>/<image>`. Empty (the " +
      "default) means no external registry: images are built into and run " +
      "from the local Docker daemon (local mode). A cluster " +
      "sets it to its in-cluster registry (e.g. the bundled Zot).",
    validate: registryHost,
  },
  "imageBuilder.kind": {
    options: builderKinds,
    plane: false,
    label: "Image builder",
    description:
      "Which build backend to use: docker (shell out to a Docker daemon, " +
      "local mode) or buildkit (in-cluster builds, dispatched to the " +
      "buildkitd endpoint set below).",
    validate: validateBuilderKind,
  },
  "imageBuilder.image": {
    plane: false,
    label: "Builder image override",
    description:
      "Override the buildkit buildctl client image. Empty uses the pinned " +
      "default. Ignored for the docker backend.",
    validate: optionalString,
  },
  "imageBuilder.endpoint": {
    plane: false,
    label: "BuildKit endpoint",
    description:
      "Address of the buildkitd daemon (e.g. " +
      "tcp://buildkitd.buildkit.svc:1234). Required when the builder is " +
      "buildkit; ignored for the docker backend.",
    validate: optionalString,
  },
  "imageBuilder.dockerHost": {
    plane: false,
    label: "Docker host",
    description:
      "Docker daemon URL (e.g. tcp://docker-host:2375) for the docker " +
      "backend. Empty inherits the process DOCKER_HOST / local socket. " +
      "Ignored for other backends.",
    validate: optionalString,
  },
  "imageBuilder.platform": {
    plane: false,
    label: "Build platform",
    description:
      "Target build platform for every backend (e.g. linux/amd64, " +
      "linux/arm64). Empty (the default) builds for the daemon's native " +
      "architecture — no emulation on an arm64 host.",
    validate: optionalString,
  },
  "imageBuilder.cacheRepo": {
    plane: false,
    label: "Build cache repo",
    description:
      "Cache repository used by the builder. Empty defaults to " +
      "`<registry>/cache`.",
    validate: optionalString,
  },
  "imageBuilder.insecureRegistry": {
    plane: false,
    label: "Insecure registry",
    description:
      "Treat the destination/cache registry as insecure (HTTP / self-signed). " +
      "On by default because the bundled Zot runs without TLS; turn off for a " +
      "TLS registry.",
    validate: validateBool,
  },
  "imageBuilder.tls.secretName": {
    plane: false,
    label: "BuildKit TLS secret",
    description:
      "Name of a K8s Secret (ca.crt/tls.crt/tls.key) for mTLS to buildkitd. " +
      "Empty talks plaintext. Only relevant for the buildkit backend.",
    validate: optionalString,
  },
  "imageBuilder.tls.serverName": {
    plane: false,
    label: "BuildKit TLS server name",
    description:
      "Override the server name used for buildkitd TLS hostname verification " +
      "(--tlsservername). Only relevant for the buildkit backend.",
    validate: optionalString,
  },
  "sandbox.defaultImage": {
    plane: true,
    label: "Default sandbox image",
    description:
      "Base image used for a new sandbox (or toolset build) when the request " +
      "does not name one. A built image / seed name (e.g. dev-base) or a " +
      "registered external ref.",
    validate: requiredString,
  },
  "sandbox.defaultVcpus": {
    plane: true,
    label: "Default sandbox vCPUs",
    description:
      "vCPUs given to a new sandbox whose create request omits " +
      "`resources.vcpus`.",
    validate: positiveInt,
  },
  "sandbox.defaultMemoryMb": {
    plane: true,
    label: "Default sandbox memory (MB)",
    description:
      "Guest RAM in MB given to a new sandbox whose create request omits " +
      "`resources.memoryMb`.",
    validate: memoryMb,
  },
  "sandbox.agentImage": {
    plane: true,
    label: "In-pod agent image",
    description:
      "Prebuilt Rust agent image the base seeds bake in via the AGENT_IMAGE " +
      "build-arg (COPY --from). Defaults to the public GHCR image so no " +
      "in-cluster agent build is needed; point it at a private/mirrored ref " +
      "for air-gapped clusters that cannot reach GHCR.",
    validate: requiredString,
  },
  "kubernetes.defaultVolumeSize": {
    plane: true,
    label: "Default volume size",
    description:
      "Default sandbox PVC size (K8s quantity, e.g. 10Gi) when a request " +
      "does not set an explicit disk size.",
    validate: k8sQuantity,
  },
  "kubernetes.storageClass": {
    plane: false,
    label: "Storage class",
    description:
      "StorageClass for sandbox PVCs. Empty uses the cluster default. Must " +
      "support Block volumes + block-volume VolumeSnapshots (e.g. " +
      "topolvm-thin).",
    validate: optionalString,
  },
  "kubernetes.volumeSnapshotClass": {
    plane: false,
    label: "Volume snapshot class",
    description:
      "VolumeSnapshotClass for prebuild snapshots (required for instant " +
      "clone-from-prebuild). Empty uses the cluster default.",
    validate: optionalString,
  },
  "sandbox.idle.mode": {
    options: idleModes,
    plane: true,
    label: "Idle auto-pause",
    description:
      "Pause running sandboxes nobody uses. observe computes and shows when " +
      "each sandbox would pause without pausing it (use it to tune the " +
      "thresholds below); enforce pauses them; off disables the feature.",
    validate: validateIdleMode,
  },
  "sandbox.idle.minutes": {
    plane: true,
    label: "Idle time before pause (minutes)",
    description:
      "How long a sandbox must go without activity before it is paused.",
    validate: positiveInt,
  },
  "sandbox.idle.network": {
    plane: true,
    label: "Idle: network traffic counts",
    description:
      "Count network traffic at or above the threshold below as activity " +
      "(its URLs, SSH, an agent calling an LLM API, git).",
    validate: validateBool,
  },
  "sandbox.idle.networkMinBytesPerMinute": {
    plane: true,
    label: "Idle: network bytes per minute",
    description:
      "Bytes received plus sent a minute must reach to count as " +
      "activity. Keeps the heartbeats of a forgotten editor tab or SSH " +
      "session from holding a sandbox awake.",
    validate: positiveInt,
  },
  "sandbox.idle.files": {
    plane: true,
    label: "Idle: file writes count",
    description:
      "Count file writes in the sandbox (the agent's built-in filter skips " +
      "dependency installs, build output, logs and tool state) as activity.",
    validate: validateBool,
  },
  "sandbox.idle.cpu": {
    plane: true,
    label: "Idle: CPU usage counts",
    description:
      "Count CPU usage above the threshold below as activity (catches a " +
      "long unattended build). Off by default: a runaway process would " +
      "keep its sandbox awake forever.",
    validate: validateBool,
  },
  "sandbox.idle.cpuMinMillicores": {
    plane: true,
    label: "Idle: CPU threshold (millicores)",
    description:
      "Average CPU over a minute, in millicores (1000 = one core), for " +
      "that minute to count when CPU usage counts.",
    validate: positiveInt,
  },
  "sandbox.idle.maxKeepAwakeHours": {
    plane: true,
    label: "Idle: longest keep-awake (hours)",
    description:
      "The longest a user may exempt a sandbox from idle auto-pause.",
    validate: positiveInt,
  },
  "jobs.concurrency": {
    plane: true,
    label: "Build job concurrency",
    description:
      "How many pooled build jobs (prebuild bake, toolset build/capture) may " +
      "run at once. Extra dispatches queue. Sandbox lifecycle jobs bypass " +
      "this limit.",
    validate: positiveInt,
  },
} as const satisfies Record<string, ConfigSpec>;

export type ConfigKey = keyof typeof CONFIG_SPECS;

/** The typed value each key resolves to, derived from the schema. */
export type ConfigValues = { [K in ConfigKey]: ConfigValueAt<K> };

const defaults = schemaDefaults();

function defaultAt(path: string): ConfigValue {
  let current: unknown = defaults;
  for (const part of path.split(".")) {
    current = (current as Record<string, unknown>)[part];
  }
  return current as ConfigValue;
}

const envVarByPath = new Map<string, string>(
  Object.entries(ENV_VAR_MAPPING).map(([envVar, path]) => [path, envVar]),
);

export const CONFIG_DEFS: ConfigDef[] = (
  Object.entries(CONFIG_SPECS) as [ConfigKey, ConfigSpec][]
).map(([key, spec]) => {
  const value = defaultAt(key);
  return {
    ...spec,
    key,
    type: typeof value as ConfigDef["type"],
    default: value,
    envVar: envVarByPath.get(key) ?? "",
  };
});

export function isConfigKey(key: string): key is ConfigKey {
  return key in CONFIG_SPECS;
}

export function configDef(key: ConfigKey): ConfigDef {
  return CONFIG_DEFS.find((def) => def.key === key) as ConfigDef;
}
