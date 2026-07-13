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

export type ConfigValue = boolean | number;

export interface ConfigDef<T extends ConfigValue> {
  key: string;
  type: T extends boolean ? "boolean" : "number";
  label: string;
  description: string;
  /** Env var this key is preseeded from on first boot (sensible default
   * otherwise). DB value always wins once set. */
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
} as const;

export type ConfigKey = keyof typeof CONFIG_REGISTRY;

/** The typed value each key resolves to. */
export interface ConfigValues {
  "prebuild.gitTracking": boolean;
  "prebuild.pruneKeep": number;
}

export const CONFIG_DEFS = Object.values(
  CONFIG_REGISTRY,
) as ConfigDef<ConfigValue>[];

export function isConfigKey(key: string): key is ConfigKey {
  return key in CONFIG_REGISTRY;
}

export function configDef(key: ConfigKey): ConfigDef<ConfigValue> {
  return CONFIG_REGISTRY[key] as ConfigDef<ConfigValue>;
}
