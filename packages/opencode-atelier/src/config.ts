import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const AtelierConfigSchema = z.object({
  $schema: z.string().optional(),
  managerUrl: z.string().default("http://localhost:4000"),
  apiKey: z.string().optional(),
  workspaceId: z.string().optional(),
  pollIntervalMs: z.number().int().positive().default(3000),
  pollTimeoutMs: z.number().int().positive().default(120_000),
});

export type AtelierConfig = z.infer<typeof AtelierConfigSchema>;

// ---------------------------------------------------------------------------
// JSONC parser (state-machine approach — safe for strings containing // or /*)
// ---------------------------------------------------------------------------

function stripJsoncComments(content: string): string {
  let result = "";
  let i = 0;
  let inString = false;
  let escaped = false;

  while (i < content.length) {
    const ch = content[i];
    const next = content[i + 1];

    if (inString) {
      result += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      i++;
      continue;
    }

    // Not in string
    if (ch === '"') {
      inString = true;
      result += ch;
      i++;
    } else if (ch === "/" && next === "/") {
      // Single-line comment — skip to end of line
      i += 2;
      while (i < content.length && content[i] !== "\n") i++;
    } else if (ch === "/" && next === "*") {
      // Multi-line comment — skip to */
      i += 2;
      while (
        i < content.length &&
        !(content[i] === "*" && content[i + 1] === "/")
      )
        i++;
      i += 2; // skip closing */
    } else {
      result += ch;
      i++;
    }
  }

  return result;
}

function parseJsonc<T>(content: string): T {
  const stripped = stripJsoncComments(content)
    // Remove trailing commas before } or ]
    .replace(/,\s*([\]}])/g, "$1");
  return JSON.parse(stripped) as T;
}

// ---------------------------------------------------------------------------
// File detection
// ---------------------------------------------------------------------------

const CONFIG_NAMES = ["atelier.jsonc", "atelier.json"];

function detectConfigFile(dir: string): string | null {
  for (const name of CONFIG_NAMES) {
    const filePath = join(dir, name);
    if (existsSync(filePath)) return filePath;
  }
  return null;
}

function loadFromPath(filePath: string): Record<string, unknown> | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    return parseJsonc<Record<string, unknown>>(content);
  } catch (err) {
    console.warn(`[atelier] Failed to load config from ${filePath}: ${err}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Env-var overrides (highest priority)
// ---------------------------------------------------------------------------

function applyEnvOverrides(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const env = process.env;

  if (env.ATELIER_MANAGER_URL) {
    config.managerUrl = env.ATELIER_MANAGER_URL;
  }
  // Support both new and legacy env var names
  const apiKeyEnv = env.ATELIER_API_KEY || env.ATELIER_API_TOKEN;
  if (apiKeyEnv) {
    config.apiKey = apiKeyEnv;
  }
  if (env.ATELIER_WORKSPACE_ID) {
    config.workspaceId = env.ATELIER_WORKSPACE_ID;
  }
  if (env.ATELIER_POLL_INTERVAL_MS) {
    config.pollIntervalMs = Number(env.ATELIER_POLL_INTERVAL_MS);
  }
  if (env.ATELIER_POLL_TIMEOUT_MS) {
    config.pollTimeoutMs = Number(env.ATELIER_POLL_TIMEOUT_MS);
  }

  return config;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load Atelier config with layered precedence:
 *   1. Global:  ~/.config/opencode/atelier.json[c]
 *   2. Project: <projectDir>/.opencode/atelier.json[c]
 *   3. Env vars (ATELIER_MANAGER_URL, ATELIER_API_KEY, etc.)
 *   4. Zod defaults for anything still missing
 */
export function loadAtelierConfig(projectDir: string): AtelierConfig {
  let merged: Record<string, unknown> = {};

  // 1. Global config
  const globalDir = join(homedir(), ".config", "opencode");
  const globalPath = detectConfigFile(globalDir);

  if (globalPath) {
    const global = loadFromPath(globalPath);
    if (global) {
      merged = { ...global };
      console.log(`[atelier] Loaded global config from ${globalPath}`);
    }
  }

  // 2. Project config (overrides global)
  const projectConfigDir = join(projectDir, ".opencode");
  const projectPath = detectConfigFile(projectConfigDir);

  if (projectPath) {
    const project = loadFromPath(projectPath);
    if (project) {
      merged = { ...merged, ...project };
      console.log(`[atelier] Loaded project config from ${projectPath}`);
    }
  }

  // 3. Env overrides (override everything)
  merged = applyEnvOverrides(merged);

  // 4. Validate + apply Zod defaults
  const result = AtelierConfigSchema.safeParse(merged);

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join(", ");
    console.warn(`[atelier] Config validation issues: ${issues}`);
    console.warn("[atelier] Falling back to defaults");
    return AtelierConfigSchema.parse({});
  }

  return result.data;
}
