import { existsSync, readFileSync } from "node:fs";
import { Value } from "@sinclair/typebox/value";
import {
  type AtelierConfig,
  AtelierConfigSchema,
  ENV_VAR_MAPPING,
} from "./config.schema.ts";

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
  if (path.includes("dnsServers") || path.includes("allowedUsers")) {
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
      setNestedValue(config, configPath, parseEnvValue(value, configPath));
    }
  }

  return config;
}

function loadFromFile(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) {
    return {};
  }

  try {
    const content = readFileSync(filePath, "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
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

export const CONFIG_FILE_NAME = "sandbox.config.json";

function deriveNetworkFields(config: AtelierConfig): void {
  const octets = config.network.bridgeIp.split(".");
  const subnet = octets.slice(0, 3).join(".");
  config.network.guestSubnet = subnet;
  config.network.bridgeNetmask = "24";
  config.network.bridgeCidr = `${subnet}.0/24`;
}

export interface LoadConfigOptions {
  configFile?: string;
  skipEnv?: boolean;
  skipFile?: boolean;
}

/**
 * Generate a default config from the schema.
 * Single source of truth — no hand-written DEFAULT_CONFIG object.
 * Note: `runtime.mode` has no schema default, so we inject "mock" here.
 */
export function getDefaultConfig(): AtelierConfig {
  const base = { runtime: { mode: "mock" } };
  const withDefaults = Value.Default(AtelierConfigSchema, base);
  const converted = Value.Convert(AtelierConfigSchema, withDefaults);
  const cleaned = Value.Clean(AtelierConfigSchema, converted);
  const config = cleaned as AtelierConfig;
  deriveNetworkFields(config);
  return config;
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
  deriveNetworkFields(config);
  return config;
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
  const isProduction = config.runtime.mode === "production";

  const schemaErrors = [...Value.Errors(AtelierConfigSchema, config)];
  for (const err of schemaErrors) {
    errors.push({
      field: err.path,
      message: err.message,
    });
  }

  if (isProduction || options.requireAuth) {
    if (!config.auth.githubClientId) {
      errors.push({
        field: "auth.githubClientId",
        message: "GitHub client ID is required (set GITHUB_CLIENT_ID)",
      });
    }
    if (!config.auth.githubClientSecret) {
      errors.push({
        field: "auth.githubClientSecret",
        message: "GitHub client secret is required (set GITHUB_CLIENT_SECRET)",
      });
    }
    if (config.auth.jwtSecret === "dev-secret-change-in-production") {
      errors.push({
        field: "auth.jwtSecret",
        message: "JWT secret must be changed from default (set JWT_SECRET)",
      });
    }
  }

  if (isProduction || options.requireDomains) {
    if (config.domains.sandboxSuffix === "localhost") {
      errors.push({
        field: "domains.sandboxSuffix",
        message:
          "Domain suffix should be configured for production (set ATELIER_SANDBOX_DOMAIN_SUFFIX)",
      });
    }

    const hasCert = config.tls.certPath?.trim().length > 0;
    const hasKey = config.tls.keyPath?.trim().length > 0;

    if ((hasCert && !hasKey) || (!hasCert && hasKey)) {
      errors.push({
        field: "tls",
        message:
          "Both tls.certPath and tls.keyPath are required for manual TLS",
      });
    }

    if (!hasCert && !hasKey && !config.tls.email) {
      errors.push({
        field: "tls.email",
        message: "TLS email is required for automatic HTTPS (set TLS_EMAIL)",
      });
    }
  }

  return errors;
}

export function assertConfigValid(
  config: AtelierConfig,
  options: ValidateConfigOptions = {},
): void {
  const errors = validateConfig(config, options);
  if (errors.length > 0) {
    const messages = errors
      .map((e) => `  - ${e.field}: ${e.message}`)
      .join("\n");
    throw new Error(`Configuration validation failed:\n${messages}`);
  }
}
