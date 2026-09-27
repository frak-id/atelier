/**
 * Hub configuration: a JSON file (`HUB_CONFIG`, default `hub.config.json`)
 * for structure, the environment for secrets. The file holds only token
 * *hashes*, so it can live in git; raw tokens, the webhook secret, the git
 * token and the embeddings key never do.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Actor } from "@atelier/knowledge";

/**
 * What a token may do:
 * - `read`: search, graph, active memories.
 * - `propose`: propose memories, flag them as wrong (agents get this).
 * - `review`: the governance queue: approve/reject/edit/restore/archive/
 *   erase, and read every memory and the audit log.
 * - `index`: trigger re-indexing.
 */
export type HubScope = "read" | "propose" | "review" | "index";

export const HUB_SCOPES: readonly HubScope[] = [
  "read",
  "propose",
  "review",
  "index",
];

export interface TokenConfig {
  name: string;
  /** Hex sha256 of the raw bearer token (`hub token` mints both). */
  sha256: string;
  actor: Actor;
  scopes: HubScope[];
}

export interface RepoConfig {
  /** `owner/name`. */
  repo: string;
  branch: string;
  /** Default `https://github.com/<repo>.git`. */
  cloneUrl?: string;
  includeFiles?: boolean;
  includeExternalDeps?: boolean;
  /** Generate codebase recaps for this repo (default true). */
  recaps?: boolean;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";

const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
];

export type LlmApi = "anthropic-messages" | "openai-completions";

/** The hub's LLM: used for codebase recaps (and later, summaries). */
export interface LlmConfig {
  baseUrl: string;
  api: LlmApi;
  model: string;
  thinking: ThinkingLevel;
}

export const DEFAULT_LLM_BASE_URL =
  "http://atelier-cliproxy.atelier-system.svc.cluster.local:8317";

/**
 * Slack isn't connected yet: this only sizes the sweep the future Slack
 * connector will run. Kept here now so the config shape is settled.
 */
export interface RetentionConfig {
  /** Messages older than this are not synced / erased by a daily sweep. */
  slackMonths: number;
}

/** How codebase recaps run: a headless `pi` explores each tracked repo. */
export interface RecapsConfig {
  enabled: boolean;
  /** argv prefix for the pi CLI, e.g. `["pi"]` or an absolute path. */
  piCommand: string[];
  /** How many areas to recap in parallel. */
  concurrency: number;
  /** Per pi invocation. */
  timeoutMinutes: number;
  /** Upper bound on areas a plan may declare. */
  maxAreas: number;
}

export type EmbeddingsConfig =
  | { provider: "hashing"; dimensions?: number }
  | {
      provider: "openai-compatible";
      baseUrl: string;
      model: string;
      dimensions: number;
    };

export interface HubConfig {
  port: number;
  /** DB and repository checkouts live here. */
  dataDir: string;
  tokens: TokenConfig[];
  repos: RepoConfig[];
  embeddings?: EmbeddingsConfig;
  /** Periodic full re-index (catches missed webhooks); 0 disables. */
  reindexIntervalMinutes: number;
  llm: LlmConfig;
  retention: RetentionConfig;
  recaps: RecapsConfig;
  secrets: {
    webhookSecret?: string;
    gitToken?: string;
    embeddingsApiKey?: string;
    llmApiKey?: string;
  };
}

type FileConfig = Partial<Omit<HubConfig, "secrets">>;

function fail(message: string): never {
  throw new Error(`hub config: ${message}`);
}

function validateToken(token: TokenConfig, index: number): void {
  const where = `tokens[${index}]`;
  if (!token.name) fail(`${where}.name is required`);
  if (!/^[0-9a-f]{64}$/.test(token.sha256 ?? "")) {
    fail(`${where}.sha256 must be a hex sha256`);
  }
  if (!token.actor?.id || !token.actor.kind) {
    fail(`${where}.actor needs kind and id`);
  }
  for (const scope of token.scopes ?? []) {
    if (!HUB_SCOPES.includes(scope)) fail(`${where}: unknown scope ${scope}`);
  }
}

function validateRepo(repo: RepoConfig, index: number): void {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo.repo ?? "")) {
    fail(`repos[${index}].repo must be owner/name`);
  }
  if (!repo.branch) fail(`repos[${index}].branch is required`);
}

function validateLlm(llm: LlmConfig): void {
  if (!llm.baseUrl) fail("llm.baseUrl is required");
  if (llm.api !== "anthropic-messages" && llm.api !== "openai-completions") {
    fail("llm.api must be anthropic-messages or openai-completions");
  }
  if (!llm.model) fail("llm.model is required");
  if (!THINKING_LEVELS.includes(llm.thinking)) {
    fail(`llm.thinking must be one of ${THINKING_LEVELS.join(", ")}`);
  }
}

function validateRetention(retention: RetentionConfig): void {
  if (!Number.isInteger(retention.slackMonths) || retention.slackMonths <= 0) {
    fail("retention.slackMonths must be a positive integer");
  }
}

function validateRecaps(recaps: RecapsConfig): void {
  if (
    !Array.isArray(recaps.piCommand) ||
    recaps.piCommand.length === 0 ||
    recaps.piCommand.some((s) => typeof s !== "string" || !s)
  ) {
    fail("recaps.piCommand must be a non-empty array of strings");
  }
  if (!Number.isInteger(recaps.concurrency) || recaps.concurrency <= 0) {
    fail("recaps.concurrency must be a positive integer");
  }
  if (!Number.isInteger(recaps.timeoutMinutes) || recaps.timeoutMinutes <= 0) {
    fail("recaps.timeoutMinutes must be a positive integer");
  }
  if (!Number.isInteger(recaps.maxAreas) || recaps.maxAreas <= 0) {
    fail("recaps.maxAreas must be a positive integer");
  }
}

/** Parses and validates; `file` is the decoded JSON, `env` the process env. */
export function parseConfig(
  file: FileConfig,
  env: Record<string, string | undefined>,
): HubConfig {
  const config: HubConfig = {
    port: Number(env.HUB_PORT ?? file.port ?? 4100),
    dataDir: resolve(env.HUB_DATA_DIR ?? file.dataDir ?? ".hub-data"),
    tokens: file.tokens ?? [],
    repos: file.repos ?? [],
    embeddings: file.embeddings,
    reindexIntervalMinutes: file.reindexIntervalMinutes ?? 360,
    llm: {
      baseUrl:
        env.HUB_LLM_BASE_URL || file.llm?.baseUrl || DEFAULT_LLM_BASE_URL,
      api: file.llm?.api ?? "anthropic-messages",
      model: env.HUB_LLM_MODEL || file.llm?.model || "claude-sonnet-5",
      thinking: file.llm?.thinking ?? "medium",
    },
    retention: {
      slackMonths: Number(
        env.HUB_SLACK_RETENTION_MONTHS ?? file.retention?.slackMonths ?? 6,
      ),
    },
    recaps: {
      enabled: file.recaps?.enabled ?? true,
      piCommand: file.recaps?.piCommand ?? ["pi"],
      concurrency: file.recaps?.concurrency ?? 2,
      timeoutMinutes: file.recaps?.timeoutMinutes ?? 20,
      maxAreas: file.recaps?.maxAreas ?? 30,
    },
    secrets: {
      webhookSecret: env.HUB_WEBHOOK_SECRET || undefined,
      gitToken: env.HUB_GIT_TOKEN || undefined,
      embeddingsApiKey: env.HUB_EMBEDDINGS_API_KEY || undefined,
      llmApiKey: env.HUB_LLM_API_KEY || undefined,
    },
  };
  if (!Number.isInteger(config.port) || config.port <= 0) {
    fail("port must be a positive integer");
  }
  config.tokens.forEach(validateToken);
  config.repos.forEach(validateRepo);
  validateLlm(config.llm);
  validateRetention(config.retention);
  validateRecaps(config.recaps);
  const names = new Set<string>();
  for (const t of config.tokens) {
    if (names.has(t.name)) fail(`duplicate token name ${t.name}`);
    names.add(t.name);
  }
  return config;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): HubConfig {
  const path = resolve(env.HUB_CONFIG ?? "hub.config.json");
  let file: FileConfig = {};
  if (existsSync(path)) {
    file = JSON.parse(readFileSync(path, "utf8")) as FileConfig;
  } else if (env.HUB_CONFIG) {
    fail(`${path} does not exist`);
  }
  return parseConfig(file, env);
}
