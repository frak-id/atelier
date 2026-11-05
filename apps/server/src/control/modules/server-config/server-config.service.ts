/**
 * Runtime server config. A thin, typed layer over the `settings` key/value
 * table, bounded to the keys declared in `registry.ts`.
 *
 * Two kinds of key (the registry's `plane` flag):
 *  - infrastructure (`plane: false`): set by the deployment (config file or
 *    env) only. Always read straight off `config`, never stored, never
 *    editable here.
 *  - operational (`plane: true`): editable by server admins. LOCKED
 *    (read-only, live) when the operator set it explicitly in the config file
 *    or its env var; otherwise resolution for `get` is: stored console
 *    override -> schema default.
 */
import {
  getConfigValue,
  hasConfigPath,
} from "../../../config/config.loader.ts";
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
  /** true = operational, editable from the console unless locked; false =
   * infrastructure, set by the deployment and always read-only. */
  plane: boolean;
  /** true when the operator set nothing and no console override exists. */
  isDefault: boolean;
  /** true when the value cannot be changed here: infrastructure keys, or an
   * operational key the operator set via config file or env. */
  locked: boolean;
  /** What set it, for the UI hint (null when nothing did). */
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

  /** Whether the operator set this key explicitly (path present in the merged
   * config file + env sources) and, if so, its live value. `config` already
   * reflects file+env+schema defaults, so the value is read off it. */
  private providedBy(def: ConfigDef): Lock {
    if (!hasConfigPath(providedConfig, def.key)) {
      return { locked: false, source: null };
    }
    const rawEnv = process.env[def.envVar];
    const envSet = rawEnv !== undefined && rawEnv !== "";
    return {
      locked: true,
      source: envSet ? "env" : "file",
      value: getConfigValue<ConfigValue>(config, def.key),
    };
  }

  /** Typed read of a known key. Infrastructure keys and operator-locked
   * (file/env) keys come straight off `config`; else the console override;
   * else the default. */
  get<K extends ConfigKey>(key: K): ConfigValues[K] {
    const def = configDef(key);
    if (!def.plane || this.providedBy(def).locked) {
      return getConfigValue<ConfigValues[K]>(config, key);
    }

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
    // No override: the static config already carries the schema default.
    return getConfigValue<ConfigValues[K]>(config, key);
  }

  /** Every known key with its current value + metadata, for the surfaces. */
  list(): ConfigEntry[] {
    return CONFIG_DEFS.map((def) => {
      const provided = this.providedBy(def);
      const row = def.plane ? this.repository.get(def.key) : undefined;
      return {
        key: def.key,
        label: def.label,
        description: def.description,
        type: def.type,
        ...(def.options ? { options: def.options } : {}),
        value: this.get(def.key),
        default: def.default,
        plane: def.plane,
        isDefault: !provided.locked && row === undefined,
        locked: !def.plane || provided.locked,
        lockedBy: provided.source,
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
    if (!def.plane) {
      throw new ValidationError(
        `config key "${key}" is an infrastructure setting set by the ` +
          `deployment (config file or the ${def.envVar} env var); it cannot ` +
          "be changed here.",
      );
    }
    const lock = this.providedBy(def);
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
