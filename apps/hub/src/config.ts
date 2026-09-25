/**
 * Hub configuration: a JSON file (`HUB_CONFIG`, default `hub.config.json`)
 * for structure, the environment for secrets. The file holds only token
 * *hashes*, so it can live in git; raw tokens, the webhook secret, the git
 * token and the embeddings key never do.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Actor, Principal } from "@atelier/knowledge";

/**
 * What a token may do:
 * - `read`: search, graph, active memories visible to its audience.
 * - `propose`: propose memories, flag them as wrong (agents get this).
 * - `review`: the governance queue: approve/reject/edit/restore/archive/
 *   erase, and read every memory and the audit log regardless of audience.
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
  /**
   * Default audience of this caller's answers: who will see them. A Slack
   * gateway answering in public channels uses `["org"]`; a personal
   * assistant for alice uses `["user:alice"]`.
   */
  audience: Principal[];
  /**
   * Principals a request may name as its audience instead of the default
   * (a gateway that computes each reply's audience itself). `"*"` allows
   * any. Default: the `audience` list only.
   */
  mayAddress?: Principal[];
}

export interface RepoConfig {
  /** `owner/name`. */
  repo: string;
  branch: string;
  /** Default `https://github.com/<repo>.git`. */
  cloneUrl?: string;
  /** Default `["org"]`. Private repos should narrow this. */
  readers?: Principal[];
  includeFiles?: boolean;
  includeExternalDeps?: boolean;
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
  /** Group → members, for audience checks (`team:platform` → users). */
  teams: Record<Principal, Principal[]>;
  repos: RepoConfig[];
  embeddings?: EmbeddingsConfig;
  /** Periodic full re-index (catches missed webhooks); 0 disables. */
  reindexIntervalMinutes: number;
  secrets: {
    webhookSecret?: string;
    gitToken?: string;
    embeddingsApiKey?: string;
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
  if (!token.audience?.length) fail(`${where}.audience must not be empty`);
}

function validateRepo(repo: RepoConfig, index: number): void {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo.repo ?? "")) {
    fail(`repos[${index}].repo must be owner/name`);
  }
  if (!repo.branch) fail(`repos[${index}].branch is required`);
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
    teams: file.teams ?? {},
    repos: file.repos ?? [],
    embeddings: file.embeddings,
    reindexIntervalMinutes: file.reindexIntervalMinutes ?? 360,
    secrets: {
      webhookSecret: env.HUB_WEBHOOK_SECRET || undefined,
      gitToken: env.HUB_GIT_TOKEN || undefined,
      embeddingsApiKey: env.HUB_EMBEDDINGS_API_KEY || undefined,
    },
  };
  if (!Number.isInteger(config.port) || config.port <= 0) {
    fail("port must be a positive integer");
  }
  config.tokens.forEach(validateToken);
  config.repos.forEach(validateRepo);
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
