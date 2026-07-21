/**
 * CLI config. Named *contexts* (each a `{ baseUrl, apiKey }` pair) let you flip
 * between, say, a hosted server and a local Docker one without re-authing.
 *
 * Resolution, env wins over the on-disk file:
 *
 *   1. `~/.atelier/config.json` — the *current* context (written by
 *      `atelier login` / `config init` / `context …` / `local up`)
 *   2. `ATELIER_API_URL` / `ATELIER_API_KEY` env vars (override, for CI)
 *
 * The on-disk shape is `{ current, contexts: { <name>: { baseUrl, apiKey } } }`.
 * A legacy flat `{ baseUrl, apiKey }` file is transparently read as the single
 * `default` context, so existing installs keep working.
 *
 * The auth is the same Bearer key any API caller uses (`atl_…`/JWT minted via
 * `POST /api-keys` or the console): the CLI is exactly as privileged as any
 * other client (atelier-v2 §4).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface CliConfig {
  baseUrl: string;
  apiKey: string;
}

const DEFAULT_BASE_URL = "http://localhost:4000";
const DEFAULT_CONTEXT = "default";

/** Everything the CLI persists lives under `~/.atelier`. */
export const atelierDir: string = join(homedir(), ".atelier");

/** `~/.atelier/config.json`. */
export const configPath: string = join(atelierDir, "config.json");

interface ContextConfig {
  baseUrl?: string;
  apiKey?: string;
}

/** On-disk shape. `current` + `contexts` is canonical; the top-level
 * `baseUrl`/`apiKey` are the legacy flat form we still read + migrate. */
interface StoredConfig {
  current?: string;
  contexts?: Record<string, ContextConfig>;
  baseUrl?: string;
  apiKey?: string;
}

interface NormalizedStore {
  current: string;
  contexts: Record<string, ContextConfig>;
}

function readRaw(): StoredConfig {
  try {
    return JSON.parse(readFileSync(configPath, "utf8")) as StoredConfig;
  } catch {
    return {};
  }
}

/** Fold either on-disk shape into the canonical `{ current, contexts }`. */
function normalize(raw: StoredConfig): NormalizedStore {
  if (raw.contexts && typeof raw.contexts === "object") {
    const current =
      raw.current && raw.contexts[raw.current] ? raw.current : DEFAULT_CONTEXT;
    return { current, contexts: { ...raw.contexts } };
  }
  // Legacy flat file → a single `default` context.
  if (raw.baseUrl || raw.apiKey) {
    return {
      current: DEFAULT_CONTEXT,
      contexts: {
        [DEFAULT_CONTEXT]: { baseUrl: raw.baseUrl, apiKey: raw.apiKey },
      },
    };
  }
  return { current: DEFAULT_CONTEXT, contexts: {} };
}

function readStore(): NormalizedStore {
  return normalize(readRaw());
}

function writeStore(store: NormalizedStore): string {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(store, null, 2)}\n`, {
    mode: 0o600,
  });
  return configPath;
}

const normalizeUrl = (url: string): string => url.trim().replace(/\/+$/, "");

/** The effective config plus provenance for each field (for `doctor`/`show`). */
export interface ResolvedConfig extends CliConfig {
  baseUrlSource: "env" | "file" | "default";
  apiKeySource: "env" | "file" | "none";
  configPath: string;
  /** Name of the active context (the one env vars, if any, override). */
  context: string;
  /** All context names known on disk. */
  contexts: string[];
}

/** Merge the current context + env without throwing — used by `show`/`doctor`,
 * which must work even when nothing is configured yet. */
export function loadConfig(): ResolvedConfig {
  const store = readStore();
  const ctx = store.contexts[store.current] ?? {};
  const envUrl = process.env.ATELIER_API_URL?.trim();
  const envKey = process.env.ATELIER_API_KEY?.trim();

  const baseUrlSource = envUrl ? "env" : ctx.baseUrl ? "file" : "default";
  const apiKeySource = envKey ? "env" : ctx.apiKey ? "file" : "none";

  return {
    baseUrl: normalizeUrl(envUrl || ctx.baseUrl || DEFAULT_BASE_URL),
    apiKey: envKey || ctx.apiKey || "",
    baseUrlSource,
    apiKeySource,
    configPath,
    context: store.current,
    contexts: Object.keys(store.contexts),
  };
}

/** The strict form used by every authed command: throws a clear, actionable
 * error when no API key is resolvable. */
export function resolveConfig(): CliConfig {
  const resolved = loadConfig();
  if (!resolved.apiKey) {
    throw new Error(
      "No API key configured. Run `atelier config init`, `atelier local up`, " +
        "or set ATELIER_API_KEY (an `atl_…`/JWT from the console or " +
        "POST /api-keys).",
    );
  }
  return { baseUrl: resolved.baseUrl, apiKey: resolved.apiKey };
}

/** Persist base URL + key into the *current* context (0600, since it holds a
 * bearer secret). Returns the path written. */
export function saveConfig(cfg: CliConfig): string {
  const store = readStore();
  store.contexts[store.current] = {
    baseUrl: normalizeUrl(cfg.baseUrl),
    apiKey: cfg.apiKey.trim(),
  };
  return writeStore(store);
}

/** Update a single field of the current context, preserving the other. */
export function updateConfig(patch: Partial<CliConfig>): string {
  const store = readStore();
  const ctx = store.contexts[store.current] ?? {};
  store.contexts[store.current] = {
    baseUrl: patch.baseUrl ?? ctx.baseUrl ?? DEFAULT_BASE_URL,
    apiKey: patch.apiKey ?? ctx.apiKey ?? "",
  };
  return writeStore(store);
}

export function clearConfig(): void {
  rmSync(configPath, { force: true });
}

// ── contexts ────────────────────────────────────────────────────────────────

export interface ContextEntry extends CliConfig {
  name: string;
  current: boolean;
}

/** List every stored context with its (redacted-by-the-caller) values. */
export function listContexts(): ContextEntry[] {
  const store = readStore();
  return Object.entries(store.contexts).map(([name, ctx]) => ({
    name,
    baseUrl: ctx.baseUrl ?? "",
    apiKey: ctx.apiKey ?? "",
    current: name === store.current,
  }));
}

/** Name of the active context. */
export function currentContext(): string {
  return readStore().current;
}

/** Switch the active context. Throws if it doesn't exist. */
export function useContext(name: string): void {
  const store = readStore();
  if (!store.contexts[name]) {
    throw new Error(`unknown context "${name}"`);
  }
  store.current = name;
  writeStore(store);
}

/** Create or replace a context, optionally making it current. */
export function upsertContext(
  name: string,
  cfg: CliConfig,
  makeCurrent = true,
): string {
  const store = readStore();
  store.contexts[name] = {
    baseUrl: normalizeUrl(cfg.baseUrl),
    apiKey: cfg.apiKey.trim(),
  };
  if (makeCurrent) store.current = name;
  return writeStore(store);
}

/** Remove a context. If it was current, fall back to another (or `default`). */
export function removeContext(name: string): void {
  const store = readStore();
  if (!store.contexts[name]) {
    throw new Error(`unknown context "${name}"`);
  }
  delete store.contexts[name];
  if (store.current === name) {
    store.current = Object.keys(store.contexts)[0] ?? DEFAULT_CONTEXT;
  }
  writeStore(store);
}
