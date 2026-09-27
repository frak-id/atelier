/** Env-driven configuration for the codewiki-sync job. Every field is read
 * once from `process.env` in {@link loadConfig}; nothing here reaches into
 * the environment lazily so tests can pass a plain object. */

export interface RepoRef {
  /** GitHub org/user, e.g. "frak-id". */
  owner: string;
  /** Repo name, e.g. "atelier". */
  repo: string;
  /** Branch to sync (default "main"). */
  branch: string;
}

export interface SyncConfig {
  repos: RepoRef[];
  githubToken: string | undefined;
  dataDir: string;
  llmBaseUrl: string;
  llmApiKey: string | undefined;
  codewikiModel: string;
  codewikiFallbackModel: string;
  codewikiMaxTokens: number;
  codewikiExclude: string | undefined;
  onyxUrl: string | undefined;
  onyxApiKey: string | undefined;
  onyxCcPairId: number | undefined;
  dryRun: boolean;
}

export const DEFAULT_LLM_BASE_URL =
  "http://atelier-cliproxy.atelier-system.svc.cluster.local:8317/v1";
export const DEFAULT_CODEWIKI_MODEL = "claude-sonnet-5";
export const DEFAULT_CODEWIKI_FALLBACK_MODEL = "claude-haiku-4-5";
export const DEFAULT_CODEWIKI_MAX_TOKENS = 64000;
export const DEFAULT_BRANCH = "main";
export const DEFAULT_DATA_DIR = "/data";

/** `owner/repo` or `owner/repo@branch`. Throws with the offending entry on
 * malformed input so a typo in `CODEWIKI_REPOS` fails fast and legibly. */
export function parseRepoRef(entry: string): RepoRef {
  const trimmed = entry.trim();
  const [ownerRepo, branch] = trimmed.split("@");
  if (!ownerRepo) {
    throw new ConfigError(`Invalid repo entry: "${entry}"`);
  }
  const parts = ownerRepo.split("/");
  const owner = parts[0];
  const repo = parts[1];
  if (parts.length !== 2 || !owner || !repo) {
    throw new ConfigError(
      `Invalid repo entry: "${entry}" (expected "owner/repo" or ` +
        `"owner/repo@branch")`,
    );
  }
  return { owner, repo, branch: branch?.trim() || DEFAULT_BRANCH };
}

export function parseRepos(value: string): RepoRef[] {
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) {
    throw new ConfigError("CODEWIKI_REPOS must list at least one repo");
  }
  return entries.map(parseRepoRef);
}

/** Config errors never carry secret values — callers pass through
 * process.env directly, never a token, into the message. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function parseIntEnv(
  name: string,
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
    throw new ConfigError(`${name} must be an integer, got "${value}"`);
  }
  return parsed;
}

function parseBoolEnv(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ["1", "true", "yes"].includes(value.trim().toLowerCase());
}

/** Loads and validates config from an env-like record. Defaults to
 * `process.env` so `loadConfig()` is the normal entrypoint; tests inject a
 * plain object instead. */
export function loadConfig(
  env: Record<string, string | undefined> = process.env as Record<
    string,
    string | undefined
  >,
): SyncConfig {
  const dryRun = parseBoolEnv(env.DRY_RUN);

  const repos = parseRepos(env.CODEWIKI_REPOS ?? "");

  const llmApiKey = env.LLM_API_KEY;
  if (!dryRun && !llmApiKey) {
    throw new ConfigError("LLM_API_KEY is required unless DRY_RUN=1");
  }

  const onyxUrl = env.ONYX_URL;
  if (!dryRun && !onyxUrl) {
    throw new ConfigError("ONYX_URL is required unless DRY_RUN=1");
  }

  const onyxApiKey = env.ONYX_API_KEY;
  if (!dryRun && !onyxApiKey) {
    throw new ConfigError("ONYX_API_KEY is required unless DRY_RUN=1");
  }

  const onyxCcPairIdRaw = env.ONYX_CC_PAIR_ID;
  let onyxCcPairId: number | undefined;
  if (onyxCcPairIdRaw !== undefined && onyxCcPairIdRaw !== "") {
    onyxCcPairId = Number.parseInt(onyxCcPairIdRaw, 10);
    if (!Number.isFinite(onyxCcPairId)) {
      throw new ConfigError(
        `ONYX_CC_PAIR_ID must be an integer, got "${onyxCcPairIdRaw}"`,
      );
    }
  } else if (!dryRun) {
    throw new ConfigError("ONYX_CC_PAIR_ID is required unless DRY_RUN=1");
  }

  return {
    repos,
    githubToken: env.GITHUB_TOKEN,
    dataDir: env.DATA_DIR?.trim() || DEFAULT_DATA_DIR,
    llmBaseUrl: env.LLM_BASE_URL?.trim() || DEFAULT_LLM_BASE_URL,
    llmApiKey,
    codewikiModel: env.CODEWIKI_MODEL?.trim() || DEFAULT_CODEWIKI_MODEL,
    codewikiFallbackModel:
      env.CODEWIKI_FALLBACK_MODEL?.trim() || DEFAULT_CODEWIKI_FALLBACK_MODEL,
    codewikiMaxTokens: parseIntEnv(
      "CODEWIKI_MAX_TOKENS",
      env.CODEWIKI_MAX_TOKENS,
      DEFAULT_CODEWIKI_MAX_TOKENS,
    ),
    codewikiExclude: env.CODEWIKI_EXCLUDE || undefined,
    onyxUrl,
    onyxApiKey,
    onyxCcPairId,
    dryRun,
  };
}

/** Redacts any occurrence of `secrets` in `message` — used before logging or
 * rethrowing errors that may embed a token (e.g. from a git remote URL or an
 * HTTP client's error message). */
export function redact(message: string, secrets: (string | undefined)[]) {
  let out = message;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join("***");
  }
  return out;
}
