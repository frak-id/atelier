/**
 * Runtime server config (the config plane). A thin, typed layer over the
 * `settings` key/value table, bounded to the keys declared in `registry.ts`.
 *
 * Provenance / lock: a key is LOCKED (read-only, live) when the operator set
 * it explicitly — either via a config-file path (mounted `sandbox.config.json`)
 * or its env var. Locked keys surface the operator's actual value and reject
 * `set`, so the console/CLI/MCP can display but never change them. When a key
 * is NOT locked, resolution for `get` is: stored console override → default.
 */
import { getConfigValue, hasConfigPath } from "@frak/atelier-shared";
import { ValidationError } from "../../../shared/errors.ts";
import { config, providedConfig } from "../../../shared/lib/config.ts";
import { createChildLogger } from "../../../shared/lib/logger.ts";
import {
  CONFIG_DEFS,
  type ConfigDef,
  type ConfigKey,
  type ConfigValue,
  type ConfigValues,
  configDef,
  configPathFor,
  isConfigKey,
} from "./registry.ts";
import type { ServerConfigRepository } from "./server-config.repository.ts";

const log = createChildLogger("server-config");

export interface ConfigEntry {
  key: ConfigKey;
  label: string;
  description: string;
  type: "boolean" | "number" | "string";
  /** Allowed values for enum-style string keys (renders a select). */
  options?: readonly string[];
  value: ConfigValue;
  default: ConfigValue;
  /** true when the operator set nothing and no console override exists. */
  isDefault: boolean;
  /** true when the operator set this via config file or env — read-only. */
  locked: boolean;
  /** How it is locked, for the UI hint (null when unlocked). */
  lockedBy: "file" | "env" | null;
  /** The env var that also locks this key when set. */
  envVar: string;
  updatedAt: string | null;
}

interface Lock {
  locked: boolean;
  source: "file" | "env" | null;
  /** The operator's actual value when locked. */
  value?: ConfigValue;
}

export class ServerConfigService {
  constructor(private readonly repository: ServerConfigRepository) {}

  /** Resolve whether a key is operator-locked and, if so, its live value.
   * A key locks when the operator set it explicitly: for config-file-backed
   * keys, presence in the merged file+env sources; for plane-only keys, a
   * non-empty env var. `config` already reflects file+env+defaults, so the
   * locked value is read straight off it. */
  private lockOf(def: ConfigDef<ConfigValue>): Lock {
    const rawEnv = process.env[def.envVar];
    const envSet = rawEnv !== undefined && rawEnv !== "";
    const path = configPathFor(def.key as ConfigKey);
    if (path !== undefined) {
      if (hasConfigPath(providedConfig, path)) {
        return {
          locked: true,
          source: envSet ? "env" : "file",
          value: getConfigValue<ConfigValue>(config, path),
        };
      }
      return { locked: false, source: null };
    }
    // Plane-only key: env var is the only operator source.
    if (envSet) {
      try {
        return { locked: true, source: "env", value: def.parseEnv(rawEnv) };
      } catch {
        log.warn(
          { key: def.key, envVar: def.envVar, value: rawEnv },
          "invalid env-locked config; treating as unset",
        );
      }
    }
    return { locked: false, source: null };
  }

  /** Typed read of a known key. Operator lock (file/env) wins and is live;
   * else the console override; else the default. */
  get<K extends ConfigKey>(key: K): ConfigValues[K] {
    const def = configDef(key);
    const lock = this.lockOf(def);
    if (lock.locked) return lock.value as ConfigValues[K];

    const row = this.repository.get(key);
    if (row !== undefined) {
      try {
        return def.validate(row.value) as ConfigValues[K];
      } catch {
        // A hand-corrupted row must not brick the feature reading it.
        log.warn(
          { key, value: row.value },
          "invalid stored config; using default",
        );
      }
    }
    // No override: for file-backed keys the static config already carries the
    // schema default; plane-only keys use their hard-coded default.
    const path = configPathFor(key);
    if (path !== undefined)
      return getConfigValue<ConfigValues[K]>(config, path);
    return def.default as ConfigValues[K];
  }

  /** Every known key with its current value + metadata, for the surfaces. */
  list(): ConfigEntry[] {
    return CONFIG_DEFS.map((def) => {
      const lock = this.lockOf(def);
      const row = this.repository.get(def.key);
      return {
        key: def.key as ConfigKey,
        label: def.label,
        description: def.description,
        type: def.type,
        ...(def.options ? { options: def.options } : {}),
        value: this.get(def.key as ConfigKey),
        default: def.default,
        isDefault: !lock.locked && row === undefined,
        locked: lock.locked,
        lockedBy: lock.source,
        envVar: def.envVar,
        updatedAt: row?.updatedAt ?? null,
      };
    });
  }

  /** Validate + persist a known key. Unknown keys are rejected (the store is
   * a closed set, not a scratchpad); operator-locked keys are read-only.
   * Returns the stored typed value. */
  set(key: string, value: unknown): ConfigValue {
    if (!isConfigKey(key)) {
      throw new ValidationError(`unknown config key "${key}"`);
    }
    const def = configDef(key);
    const lock = this.lockOf(def);
    if (lock.locked) {
      const via =
        lock.source === "env"
          ? `the ${def.envVar} env var`
          : "the server config file";
      throw new ValidationError(
        `config key "${key}" is locked by ${via} and cannot be changed here; ` +
          "unset it there to edit from the console.",
      );
    }
    const parsed = def.validate(value);
    this.repository.set(key, parsed);
    log.info({ key, value: parsed }, "config updated");
    return parsed;
  }
}
