/**
 * CLI config. Two layers, env wins over the on-disk file:
 *
 *   1. `~/.config/atelier/config.json` (written by `atelier config init`)
 *   2. `ATELIER_API_URL` / `ATELIER_API_KEY` env vars (override, for CI)
 *
 * The auth is the same Bearer key any API caller uses (`atl_…`/JWT minted via
 * `POST /api-keys` or the console): the CLI is exactly as privileged as any
 * other client (atelier-v2 §4).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import envPaths from "env-paths";

export interface CliConfig {
  baseUrl: string;
  apiKey: string;
}

const DEFAULT_BASE_URL = "http://localhost:4000";

/** `~/.config/atelier/config.json` (no `-nodejs` suffix). */
export const configPath: string = join(
  envPaths("atelier", { suffix: "" }).config,
  "config.json",
);

interface StoredConfig {
  baseUrl?: string;
  apiKey?: string;
}

function readStored(): StoredConfig {
  try {
    return JSON.parse(readFileSync(configPath, "utf8")) as StoredConfig;
  } catch {
    return {};
  }
}

const normalizeUrl = (url: string): string => url.trim().replace(/\/+$/, "");

/** The effective config plus provenance for each field (for `doctor`/`show`). */
export interface ResolvedConfig extends CliConfig {
  baseUrlSource: "env" | "file" | "default";
  apiKeySource: "env" | "file" | "none";
  configPath: string;
}

/** Merge file + env without throwing — used by `show`/`doctor`, which must
 * work even when nothing is configured yet. */
export function loadConfig(): ResolvedConfig {
  const stored = readStored();
  const envUrl = process.env.ATELIER_API_URL?.trim();
  const envKey = process.env.ATELIER_API_KEY?.trim();

  const baseUrlSource = envUrl ? "env" : stored.baseUrl ? "file" : "default";
  const apiKeySource = envKey ? "env" : stored.apiKey ? "file" : "none";

  return {
    baseUrl: normalizeUrl(envUrl || stored.baseUrl || DEFAULT_BASE_URL),
    apiKey: envKey || stored.apiKey || "",
    baseUrlSource,
    apiKeySource,
    configPath,
  };
}

/** The strict form used by every authed command: throws a clear, actionable
 * error when no API key is resolvable. */
export function resolveConfig(): CliConfig {
  const resolved = loadConfig();
  if (!resolved.apiKey) {
    throw new Error(
      "No API key configured. Run `atelier config init`, or set " +
        "ATELIER_API_KEY (an `atl_…`/JWT from the console or POST /api-keys).",
    );
  }
  return { baseUrl: resolved.baseUrl, apiKey: resolved.apiKey };
}

/** Persist base URL + key to the on-disk config (0600, since it holds a
 * bearer secret). Returns the path written. */
export function saveConfig(cfg: CliConfig): string {
  const merged: StoredConfig = {
    baseUrl: normalizeUrl(cfg.baseUrl),
    apiKey: cfg.apiKey.trim(),
  };
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(merged, null, 2)}\n`, {
    mode: 0o600,
  });
  return configPath;
}

/** Update a single stored field, preserving the other. */
export function updateConfig(patch: Partial<CliConfig>): string {
  const stored = readStored();
  return saveConfig({
    baseUrl: patch.baseUrl ?? stored.baseUrl ?? DEFAULT_BASE_URL,
    apiKey: patch.apiKey ?? stored.apiKey ?? "",
  });
}

export function clearConfig(): void {
  rmSync(configPath, { force: true });
}
