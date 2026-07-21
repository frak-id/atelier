/**
 * Runtime server config (the config plane). A thin, typed layer over the
 * `settings` key/value table, bounded to the keys declared in `registry.ts`.
 *
 * Env lock: when a key's env var (Helm/operator) is set to a non-empty value
 * it is authoritative and LIVE — `get` returns the env value and `set` is
 * rejected, so the console/CLI/MCP can display but never change it. Resolution
 * order for `get` when unlocked: stored value → hard-coded default.
 */
import { ValidationError } from "../../../shared/errors.ts";
import { createChildLogger } from "../../../shared/lib/logger.ts";
import {
  CONFIG_DEFS,
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
  /** true when no stored override exists (still the hard-coded default). */
  isDefault: boolean;
  /** true when the key's env var is set — value is env-forced and read-only. */
  locked: boolean;
  /** The env var that locks this key when set (for the "locked by" hint). */
  envVar: string;
  updatedAt: string | null;
}

export class ServerConfigService {
  constructor(private readonly repository: ServerConfigRepository) {}

  /** Whether this key is currently locked by a non-empty env var. */
  private lockValue(envVar: string): string | undefined {
    const raw = process.env[envVar];
    return raw !== undefined && raw !== "" ? raw : undefined;
  }

  /** Typed read of a known key. Env var (when set) wins and is live; else the
   * stored override; else the hard-coded default. */
  get<K extends ConfigKey>(key: K): ConfigValues[K] {
    const def = configDef(key);
    const locked = this.lockValue(def.envVar);
    if (locked !== undefined) {
      try {
        return def.parseEnv(locked) as ConfigValues[K];
      } catch {
        // A malformed env override must not brick reads — fall through to the
        // stored value / default rather than crash the consumer.
        log.warn(
          { key, envVar: def.envVar, value: locked },
          "invalid env-locked config; falling back",
        );
      }
    }
    const row = this.repository.get(key);
    if (row === undefined) return def.default as ConfigValues[K];
    try {
      return def.validate(row.value) as ConfigValues[K];
    } catch {
      // A hand-corrupted row must not brick the feature reading it.
      log.warn(
        { key, value: row.value },
        "invalid stored config; using default",
      );
      return def.default as ConfigValues[K];
    }
  }

  /** Every known key with its current value + metadata, for the surfaces. */
  list(): ConfigEntry[] {
    return CONFIG_DEFS.map((def) => {
      const locked = this.lockValue(def.envVar) !== undefined;
      const row = this.repository.get(def.key);
      return {
        key: def.key as ConfigKey,
        label: def.label,
        description: def.description,
        type: def.type,
        ...(def.options ? { options: def.options } : {}),
        value: this.get(def.key as ConfigKey),
        default: def.default,
        isDefault: !locked && row === undefined,
        locked,
        envVar: def.envVar,
        updatedAt: row?.updatedAt ?? null,
      };
    });
  }

  /** Validate + persist a known key. Unknown keys are rejected (the store is
   * a closed set, not a scratchpad); env-locked keys are read-only. Returns
   * the stored typed value. */
  set(key: string, value: unknown): ConfigValue {
    if (!isConfigKey(key)) {
      throw new ValidationError(`unknown config key "${key}"`);
    }
    const def = configDef(key);
    if (this.lockValue(def.envVar) !== undefined) {
      throw new ValidationError(
        `config key "${key}" is locked by the ${def.envVar} env var and ` +
          "cannot be changed here; unset it to edit from the console.",
      );
    }
    const parsed = def.validate(value);
    this.repository.set(key, parsed);
    log.info({ key, value: parsed }, "config updated");
    return parsed;
  }
}
