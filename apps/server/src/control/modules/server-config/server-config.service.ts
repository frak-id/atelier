/**
 * Runtime server config (the config plane). A thin, typed layer over the
 * `settings` key/value table, bounded to the keys declared in `registry.ts`.
 *
 * Resolution order for `get`: stored value → hard-coded default. `seedFromEnv`
 * (called once at boot) persists the env-derived value for any key not yet
 * stored, so an operator can preseed defaults via env without pinning them —
 * a later `set` (API/CLI/MCP/console) still wins.
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
  type: "boolean" | "number";
  value: ConfigValue;
  default: ConfigValue;
  /** true when no stored override exists (still the hard-coded default). */
  isDefault: boolean;
  updatedAt: string | null;
}

export class ServerConfigService {
  constructor(private readonly repository: ServerConfigRepository) {}

  /** Typed read of a known key — stored value or its hard-coded default. */
  get<K extends ConfigKey>(key: K): ConfigValues[K] {
    const def = configDef(key);
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
      const row = this.repository.get(def.key);
      return {
        key: def.key as ConfigKey,
        label: def.label,
        description: def.description,
        type: def.type,
        value: row === undefined ? def.default : this.get(def.key as ConfigKey),
        default: def.default,
        isDefault: row === undefined,
        updatedAt: row?.updatedAt ?? null,
      };
    });
  }

  /** Validate + persist a known key. Unknown keys are rejected (the store is
   * a closed set, not a scratchpad). Returns the stored typed value. */
  set(key: string, value: unknown): ConfigValue {
    if (!isConfigKey(key)) {
      throw new ValidationError(`unknown config key "${key}"`);
    }
    const def = configDef(key);
    const parsed = def.validate(value);
    this.repository.set(key, parsed);
    log.info({ key, value: parsed }, "config updated");
    return parsed;
  }

  /** Boot-time preseed: for any unset key whose env var is present, persist
   * the env-derived value. DB rows are never overwritten (idempotent across
   * restarts). */
  seedFromEnv(): void {
    for (const def of CONFIG_DEFS) {
      if (this.repository.get(def.key) !== undefined) continue;
      const raw = process.env[def.envVar];
      if (raw === undefined || raw === "") continue;
      try {
        const value = def.parseEnv(raw);
        this.repository.set(def.key, value);
        log.info({ key: def.key, envVar: def.envVar, value }, "config seeded");
      } catch (err) {
        log.warn(
          { key: def.key, envVar: def.envVar, raw, err },
          "ignoring invalid env seed for config key",
        );
      }
    }
  }
}
