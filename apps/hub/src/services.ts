/**
 * Manual DI for the hub, in the style of `apps/server/src/api/container.ts`:
 * one place builds every service; routes and MCP tools receive this object.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  type AccessResolver,
  AuditLog,
  type Embedder,
  HashingEmbedder,
  type KnowledgeDb,
  KnowledgeSearch,
  MemoryService,
  membershipResolver,
  OpenAICompatibleEmbedder,
  openKnowledgeDb,
  SqliteDocumentStore,
  SqliteGraphStore,
} from "@atelier/knowledge";
import { TokenAuth } from "./auth.ts";
import type { EmbeddingsConfig, HubConfig } from "./config.ts";
import { IndexRunner, type IndexRunnerDeps } from "./indexing.ts";

export interface HubServices {
  config: HubConfig;
  db: KnowledgeDb;
  auth: TokenAuth;
  access: AccessResolver;
  graph: SqliteGraphStore;
  documents: SqliteDocumentStore;
  memory: MemoryService;
  audit: AuditLog;
  search: KnowledgeSearch;
  indexer: IndexRunner;
}

function createEmbedder(
  config: EmbeddingsConfig | undefined,
  apiKey: string | undefined,
): Embedder | undefined {
  if (!config) return undefined;
  if (config.provider === "hashing") {
    return new HashingEmbedder(config.dimensions);
  }
  return new OpenAICompatibleEmbedder({
    baseUrl: config.baseUrl,
    model: config.model,
    dimensions: config.dimensions,
    apiKey,
  });
}

export function createHubServices(
  config: HubConfig,
  opts: {
    /** `":memory:"` in tests; default `<dataDir>/knowledge.db`. */
    dbPath?: string;
    indexer?: Pick<IndexRunnerDeps, "checkout" | "extract">;
  } = {},
): HubServices {
  mkdirSync(config.dataDir, { recursive: true });
  const db = openKnowledgeDb(
    opts.dbPath ?? join(config.dataDir, "knowledge.db"),
  );
  const access = membershipResolver(config.teams);
  const graph = new SqliteGraphStore(db, { access });
  const documents = new SqliteDocumentStore(db);
  const embedder = createEmbedder(
    config.embeddings,
    config.secrets.embeddingsApiKey,
  );
  const search = new KnowledgeSearch(db, { embedder, access });
  return {
    config,
    db,
    auth: new TokenAuth(config.tokens),
    access,
    graph,
    documents,
    memory: new MemoryService(db, { graph }),
    audit: new AuditLog(db),
    search,
    indexer: new IndexRunner({
      db,
      graph,
      documents,
      search,
      dataDir: config.dataDir,
      gitToken: config.secrets.gitToken,
      ...opts.indexer,
    }),
  };
}
