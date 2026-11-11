import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { Kind, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  type AtelierConfig,
  AtelierConfigSchema,
  ENV_VAR_MAPPING,
} from "./config.schema.ts";

/** The shape of a service-account API key (`atl_` + 40 chars when minted). */
export const API_KEY_PATTERN = /^atl_[A-Za-z0-9_-]{32,}$/;
const SERVICE_ACCOUNT_NAME = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;

function setNestedValue(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const keys = path.split(".");
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i] as string;
    if (!(key in current)) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  const lastKey = keys[keys.length - 1] as string;
  current[lastKey] = value;
}

function parseEnvValue(value: string, path: string): unknown {
  if (path.includes("allowedUsers")) {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return value;
}

function loadFromEnv(): Record<string, unknown> {
  const config: Record<string, unknown> = {};

  for (const [envVar, configPath] of Object.entries(ENV_VAR_MAPPING)) {
    const value = process.env[envVar];
    if (value !== undefined && value !== "") {
      // Skip Kubernetes auto-injected service discovery values
      // (e.g. ATELIER_AGENT_PORT=tcp://10.43.x.x:9999)
      if (/^(tcp|udp):\/\//.test(value)) continue;
      setNestedValue(config, configPath, parseEnvValue(value, configPath));
    }
  }

  return config;
}

/** Read the config file. A missing file is fine (env + defaults apply); an
 * unparsable one or one with keys the schema doesn't know throws, so a typo
 * can't silently revert every value to its default. */
function loadFromFile(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) {
    return {};
  }

  const content = readFileSync(filePath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Config file ${filePath} is not valid JSON: ${reason}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`Config file ${filePath} must hold a JSON object`);
  }
  const unknown = unknownConfigKeys(AtelierConfigSchema, parsed, "");
  if (unknown.length > 0) {
    throw new Error(
      `Config file ${filePath} has unknown keys: ${unknown.join(", ")}`,
    );
  }
  return parsed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Dotted paths in `value` that `schema` has no property for. Only descends
 * through `Type.Object`s: a record (e.g. ingress annotations) takes any key. */
function unknownConfigKeys(
  schema: TSchema,
  value: unknown,
  path: string,
): string[] {
  if (schema[Kind] !== "Object" || !isPlainObject(value)) return [];
  const properties = schema.properties as Record<string, TSchema>;
  const unknown: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    // `$schema` points editors at the generated JSON schema.
    if (path === "" && key === "$schema") continue;
    const childPath = path ? `${path}.${key}` : key;
    const childSchema = properties[key];
    if (!childSchema) unknown.push(childPath);
    else unknown.push(...unknownConfigKeys(childSchema, child, childPath));
  }
  return unknown;
}

function deepMerge(
  target: Record<string, unknown>,
  ...sources: Record<string, unknown>[]
): Record<string, unknown> {
  const result = { ...target };

  for (const source of sources) {
    if (!source) continue;

    for (const key of Object.keys(source)) {
      const sourceValue = source[key];
      const targetValue = result[key];

      if (
        sourceValue !== undefined &&
        typeof sourceValue === "object" &&
        sourceValue !== null &&
        !Array.isArray(sourceValue) &&
        typeof targetValue === "object" &&
        targetValue !== null &&
        !Array.isArray(targetValue)
      ) {
        result[key] = deepMerge(
          targetValue as Record<string, unknown>,
          sourceValue as Record<string, unknown>,
        );
      } else if (sourceValue !== undefined) {
        result[key] = sourceValue;
      }
    }
  }

  return result;
}

const CONFIG_FILE_NAME = "sandbox.config.json";

function deriveDomainFields(config: AtelierConfig): void {
  const base = config.domain.baseDomain;
  if (!config.domain.dashboard) {
    config.domain.dashboard =
      base === "localhost" ? "sandbox.localhost" : `sandbox.${base}`;
  }
  if (!config.domain.ssh.hostname) {
    config.domain.ssh.hostname =
      base === "localhost" ? "ssh.localhost" : `ssh.${base}`;
  }
}

/** The config with only schema defaults applied (no file, no env). */
export function schemaDefaults(): AtelierConfig {
  return Value.Default(AtelierConfigSchema, {}) as AtelierConfig;
}

export interface LoadConfigOptions {
  configFile?: string;
  skipEnv?: boolean;
  skipFile?: boolean;
}

export function loadConfig(options: LoadConfigOptions = {}): AtelierConfig {
  const configFile =
    options.configFile ||
    process.env.ATELIER_CONFIG ||
    `/etc/atelier/${CONFIG_FILE_NAME}`;

  const fileConfig = options.skipFile ? {} : loadFromFile(configFile);
  const envConfig = options.skipEnv ? {} : loadFromEnv();

  const merged = deepMerge({}, fileConfig, envConfig);

  const withDefaults = Value.Default(AtelierConfigSchema, merged);
  const converted = Value.Convert(AtelierConfigSchema, withDefaults);
  const cleaned = Value.Clean(AtelierConfigSchema, converted);
  const config = cleaned as AtelierConfig;
  deriveDomainFields(config);
  return config;
}

/**
 * The operator-provided config sources (config file + env vars) deep-merged,
 * WITHOUT schema defaults applied. Used to tell whether a given key was
 * explicitly set by the operator (file/env) versus left to its default — the
 * basis for locking a key read-only in the runtime config plane.
 */
export function loadProvidedConfig(
  options: LoadConfigOptions = {},
): Record<string, unknown> {
  const configFile =
    options.configFile ||
    process.env.ATELIER_CONFIG ||
    `/etc/atelier/${CONFIG_FILE_NAME}`;

  const fileConfig = options.skipFile ? {} : loadFromFile(configFile);
  const envConfig = options.skipEnv ? {} : loadFromEnv();

  return deepMerge({}, fileConfig, envConfig);
}

/** Whether a dotted path is explicitly present in a raw (pre-defaults) config
 * object — e.g. `hasConfigPath(loadProvidedConfig(), "kubernetes.registryUrl")`. */
export function hasConfigPath(
  obj: Record<string, unknown>,
  path: string,
): boolean {
  const keys = path.split(".");
  let current: unknown = obj;
  for (const key of keys) {
    if (current === null || typeof current !== "object") return false;
    if (!(key in (current as Record<string, unknown>))) return false;
    current = (current as Record<string, unknown>)[key];
  }
  return current !== undefined;
}

export function getConfigValue<T>(config: AtelierConfig, path: string): T {
  const keys = path.split(".");
  let current: unknown = config;

  for (const key of keys) {
    if (
      current === null ||
      current === undefined ||
      typeof current !== "object"
    ) {
      throw new Error(`Config path not found: ${path}`);
    }
    current = (current as Record<string, unknown>)[key];
  }

  return current as T;
}

export interface ConfigValidationError {
  field: string;
  message: string;
}

export interface ValidateConfigOptions {
  requireAuth?: boolean;
  requireDomains?: boolean;
}

export function validateConfig(
  config: AtelierConfig,
  options: ValidateConfigOptions = {},
): ConfigValidationError[] {
  const errors: ConfigValidationError[] = [];
  const isProduction = config.server.mode === "production";

  const schemaErrors = [...Value.Errors(AtelierConfigSchema, config)];
  for (const err of schemaErrors) {
    errors.push({
      field: err.path,
      message: err.message,
    });
  }

  if (isProduction || options.requireAuth) {
    if (!config.auth.github.clientId) {
      errors.push({
        field: "auth.github.clientId",
        message: "GitHub client ID is required (set ATELIER_GITHUB_CLIENT_ID)",
      });
    }
    if (!config.auth.github.clientSecret) {
      errors.push({
        field: "auth.github.clientSecret",
        message:
          "GitHub client secret is required (set ATELIER_GITHUB_CLIENT_SECRET)",
      });
    }
    if (isProduction && !config.auth.defaultOrg) {
      errors.push({
        field: "auth.defaultOrg",
        message:
          "The team org is required in production: its owners are the " +
          "server admins (set ATELIER_DEFAULT_ORG)",
      });
    }
    if (config.auth.jwtSecret === "dev-secret-change-in-production") {
      errors.push({
        field: "auth.jwtSecret",
        message:
          "JWT secret must be changed from default (set ATELIER_JWT_SECRET)",
      });
    }
  }

  if (isProduction || options.requireDomains) {
    if (config.domain.baseDomain === "localhost") {
      errors.push({
        field: "domain.baseDomain",
        message:
          "Base domain should be configured for production (set ATELIER_BASE_DOMAIN)",
      });
    }
  }

  errors.push(...validateServiceAccounts(config, isProduction));

  return errors;
}

function isReadable(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The declared service accounts. Names and the shape of a declaration are
 * errors everywhere; a secret that isn't there (env var unset, key file
 * unreadable, malformed API key) is an error in production only: elsewhere
 * the reconcile logs a warning and skips the account, so a laptop config
 * without the secrets still boots.
 */
function validateServiceAccounts(
  config: AtelierConfig,
  isProduction: boolean,
): ConfigValidationError[] {
  const errors: ConfigValidationError[] = [];
  const seen = new Set<string>();
  const secretProblem = (field: string, message: string) => {
    if (isProduction) errors.push({ field, message });
  };
  config.serviceAccounts.forEach((sa, i) => {
    const at = `serviceAccounts[${i}]`;
    if (!SERVICE_ACCOUNT_NAME.test(sa.name)) {
      errors.push({
        field: `${at}.name`,
        message: `'${sa.name}' must be 1-39 lowercase letters, digits or hyphens, not starting or ending with a hyphen`,
      });
    } else if (seen.has(sa.name)) {
      errors.push({
        field: `${at}.name`,
        message: `Service account '${sa.name}' is declared twice`,
      });
    }
    seen.add(sa.name);

    const github = sa.github;
    if (github && "tokenEnv" in github) {
      if (!process.env[github.tokenEnv]?.trim()) {
        secretProblem(
          `${at}.github.tokenEnv`,
          `Env var ${github.tokenEnv} is not set`,
        );
      }
    } else if (github) {
      const { privateKeyEnv, privateKeyFile } = github;
      if (github.repositories?.length === 0) {
        // Dropping it would silently widen the token to every repository.
        errors.push({
          field: `${at}.github.repositories`,
          message: "Must not be empty: omit it to allow every repository",
        });
      }
      if (!privateKeyEnv === !privateKeyFile) {
        errors.push({
          field: `${at}.github`,
          message: "Set exactly one of privateKeyEnv and privateKeyFile",
        });
      } else if (privateKeyEnv && !process.env[privateKeyEnv]?.trim()) {
        secretProblem(
          `${at}.github.privateKeyEnv`,
          `Env var ${privateKeyEnv} is not set`,
        );
      } else if (privateKeyFile && !isReadable(privateKeyFile)) {
        secretProblem(
          `${at}.github.privateKeyFile`,
          `Key file ${privateKeyFile} is not readable`,
        );
      }
    }

    if (sa.apiKey) {
      const value = process.env[sa.apiKey.env]?.trim();
      if (!value) {
        secretProblem(
          `${at}.apiKey.env`,
          `Env var ${sa.apiKey.env} is not set`,
        );
      } else if (!API_KEY_PATTERN.test(value)) {
        secretProblem(
          `${at}.apiKey.env`,
          `Env var ${sa.apiKey.env} must look like atl_ followed by 32+ letters, digits, - or _`,
        );
      }
    }
  });
  return errors;
}
