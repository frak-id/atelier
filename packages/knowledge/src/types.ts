/**
 * The `@atelier/knowledge` domain contract. Every module (memory, graph,
 * search, indexer) codes against these types; the SQL shape behind them
 * lives in `db.ts`. See `docs/proposals/company-knowledge.md`.
 *
 * Three kinds of record, three lifecycles:
 * - **Memory**: a revocable fact someone may want reviewed, corrected or
 *   erased ("team X owns service Y"). Agents only *propose*; policy or a
 *   human activates. Erase is a hard delete that cascades to everything
 *   derived from it.
 * - **Graph** (entities + facts): structure, mostly *derived* (the code
 *   indexer, approved memories). Facts are temporal: re-asserting a source
 *   invalidates what it no longer says instead of deleting history.
 * - **Documents**: chunked text corpora (repo docs today, a generated code
 *   wiki later). Rebuilt from sources, never edited by hand.
 *
 * Timestamps are epoch milliseconds (numbers), ids are opaque strings.
 */

// ── Principals & access ────────────────────────────────────────────────────

/**
 * A principal string: `org` (everyone in the company), `team:<slug>`,
 * `user:<id>`, `channel:<id>`, `repo:<owner/name>`, … Open-ended on purpose;
 * the only built-in meaning is {@link ORG_PRINCIPAL}.
 */
export type Principal = string;

/** Readable by the whole company. */
export const ORG_PRINCIPAL = "org";

/**
 * Who a record may be shown to. A record is visible to a reply's
 * {@link Audience} only if *every* audience principal is covered by one of
 * the record's readers (see {@link AccessResolver}). This is the "an answer
 * may only use sources the whole audience can read" rule.
 */
export type Readers = Principal[];

/**
 * The audience of an answer: the principals it will be shown to (a Slack
 * channel, an issue's visibility, e-mail recipients, one user in a DM).
 * An empty audience is invalid for reads — callers must say who is asking.
 */
export type Audience = Principal[];

/**
 * Decides whether `principal` is covered by a reader (membership expansion,
 * e.g. `user:alice` ∈ `team:platform`). The default resolver only knows
 * exact matches and that {@link ORG_PRINCIPAL} covers everyone.
 */
export interface AccessResolver {
  covers(reader: Principal, principal: Principal): boolean;
}

// ── Actors, provenance, derivations ────────────────────────────────────────

export type ActorKind = "human" | "agent" | "system";

/** Who did something. `id` is a principal-like string (`user:alice`). */
export interface Actor {
  kind: ActorKind;
  id: string;
}

export type ProvenanceKind =
  | "slack"
  | "github"
  | "linear"
  | "email"
  | "url"
  | "thread"
  | "session"
  | "commit"
  | "memory"
  | "manual";

/** Where a claim comes from; shown with citations. */
export interface Provenance {
  kind: ProvenanceKind;
  /** Stable reference: a permalink, `owner/repo#123`, a commit sha, … */
  ref: string;
  url?: string;
  /** Short excerpt supporting the claim (erased with the record). */
  quote?: string;
}

/**
 * Kinds of record that can take part in a derivation. `external` covers
 * artifacts outside the knowledge DB (cached transcripts, a skill PR, …)
 * which erasure reports to {@link ErasureHook}s instead of deleting itself.
 */
export type RecordKind =
  | "memory"
  | "entity"
  | "fact"
  | "document"
  | "embedding"
  | "external";

export interface RecordRef {
  kind: RecordKind;
  id: string;
}

/** `child` was derived from `parent`: erasing the parent erases the child. */
export interface Derivation {
  parent: RecordRef;
  child: RecordRef;
  createdAt: number;
}

// ── Memory ──────────────────────────────────────────────────────────────────

export type MemoryScopeKind = "org" | "team" | "repo" | "channel" | "user";

/** What a memory is about / who it applies to (not who may read it). */
export interface MemoryScope {
  kind: MemoryScopeKind;
  /** Empty string for `org`. */
  id: string;
}

export type MemoryKind =
  | "fact"
  | "decision"
  | "preference"
  | "ownership"
  | "convention"
  | "incident";

/**
 * - `proposed`: waiting for review, never served to agents.
 * - `active`: served.
 * - `stale`: flagged as possibly wrong; still visible to reviewers, served
 *   only when explicitly requested.
 * - `archived`: retired (superseded or bulk "context switch"), kept as
 *   history, never served.
 * - `rejected`: declined in review, kept for audit/dedup, never served.
 *
 * Erasure is not a status: the row is gone.
 */
export type MemoryStatus =
  | "proposed"
  | "active"
  | "stale"
  | "archived"
  | "rejected";

export interface Memory {
  id: string;
  scope: MemoryScope;
  kind: MemoryKind;
  content: string;
  tags: string[];
  status: MemoryStatus;
  readers: Readers;
  /** Graph entities this memory is about (`package:@atelier/spec`, …). */
  entityIds: string[];
  /**
   * Structured claims carried by the memory ("team:payments owns
   * service:billing"). Asserted into the graph under source
   * `memory:<id>` while the memory is `active`, retracted when it leaves
   * `active`, hard-deleted when it is erased.
   */
  facts: FactInput[];
  provenance: Provenance[];
  createdBy: Actor;
  reviewedBy?: Actor;
  reviewNote?: string;
  /** World time this is true from / until (bi-temporal "valid time"). */
  validFrom: number;
  validTo?: number;
  /** The memory this one replaces (set on the new one). */
  supersedes?: string;
  /** Set on the old one once the replacement is active. */
  supersededBy?: string;
  useCount: number;
  lastUsedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ProposeMemoryInput {
  scope: MemoryScope;
  kind: MemoryKind;
  content: string;
  tags?: string[];
  /** Defaults to readers derived from the scope (see memory policy). */
  readers?: Readers;
  entityIds?: string[];
  facts?: FactInput[];
  provenance?: Provenance[];
  validFrom?: number;
  validTo?: number;
  /** Propose this as a replacement for an existing memory. */
  supersedes?: string;
}

/** Editable fields during review (or later, by a human). */
export interface MemoryPatch {
  content?: string;
  tags?: string[];
  readers?: Readers;
  entityIds?: string[];
  facts?: FactInput[];
  scope?: MemoryScope;
  kind?: MemoryKind;
  validFrom?: number;
  validTo?: number | null;
}

export interface MemoryFilter {
  status?: MemoryStatus[];
  scope?: Partial<MemoryScope>;
  kind?: MemoryKind[];
  /** All of these tags. */
  tags?: string[];
  entityId?: string;
  createdBefore?: number;
  createdAfter?: number;
  limit?: number;
  offset?: number;
}

/**
 * Decides whether a proposal activates without review. Default: only
 * `user`-scoped `preference`s auto-activate; everything else needs a human.
 */
export interface MemoryPolicy {
  autoActivate(input: ProposeMemoryInput, actor: Actor): boolean;
  /** Readers when the proposal doesn't set them. */
  defaultReaders(scope: MemoryScope): Readers;
}

// ── Audit ──────────────────────────────────────────────────────────────────

export type AuditAction =
  | "memory.propose"
  | "memory.approve"
  | "memory.reject"
  | "memory.edit"
  | "memory.flag"
  | "memory.restore"
  | "memory.archive"
  | "memory.supersede"
  | "memory.use"
  | "memory.erase";

/**
 * Append-only. Never holds memory *content*: after an erase, the audit trail
 * proves the erase happened (and who asked) without retaining what was said.
 */
export interface AuditEntry {
  id: string;
  at: number;
  actor: Actor;
  action: AuditAction;
  target: RecordRef;
  /** Structured, content-free detail (status transitions, counts, reason). */
  detail?: Record<string, unknown>;
}

// ── Erasure ─────────────────────────────────────────────────────────────────

export interface ErasureReport {
  /** The record(s) the caller asked to erase. */
  roots: RecordRef[];
  /** Everything deleted from the knowledge DB, roots included. */
  erased: RecordRef[];
  /** `external` derivations the DB cannot delete itself. */
  external: RecordRef[];
}

/** Called once per erase with the external artifacts to clean up. */
export interface ErasureHook {
  onErase(report: ErasureReport): Promise<void> | void;
}

// ── Graph ───────────────────────────────────────────────────────────────────

/**
 * Open-ended, but these are what the indexer emits. Entity ids are
 * `<type>:<natural key>` (`repo:frak-id/atelier`,
 * `package:@atelier/spec`, `file:frak-id/atelier:apps/cli/src/index.ts`,
 * `team:platform`, `person:octocat`).
 */
export type EntityType =
  | "repo"
  | "package"
  | "crate"
  | "file"
  | "service"
  | "team"
  | "person"
  | "dependency"
  | (string & {});

export interface Entity {
  id: string;
  type: EntityType;
  name: string;
  /** Short human description (package.json `description`, README lede). */
  summary?: string;
  attrs: Record<string, unknown>;
  readers: Readers;
  /**
   * Set when the source that produced the entity stopped mentioning it (a
   * package removed from the repo). Kept so historical facts still resolve;
   * hidden from search and current-graph queries.
   */
  retiredAt?: number;
  /** The fact source that last asserted this entity, if any. */
  sourceKey?: string;
  createdAt: number;
  updatedAt: number;
}

export type EntityInput = Omit<
  Entity,
  "createdAt" | "updatedAt" | "retiredAt" | "sourceKey"
>;

export type FactType =
  | "contains"
  | "depends_on"
  | "imports"
  | "owns"
  | "maintains"
  | "documents"
  | "exposes"
  | "consumes"
  | (string & {});

/**
 * Where a fact comes from. Facts are asserted in *sets* per source key
 * (`indexer:frak-id/atelier`, `memory:<id>`, `manual`): re-asserting a
 * source replaces its set, invalidating facts it no longer states.
 */
export interface FactSource {
  key: string;
  /** Revision the set was computed at (commit sha, memory updatedAt, …). */
  revision?: string;
}

export interface Fact {
  id: string;
  type: FactType;
  from: string;
  to: string;
  attrs: Record<string, unknown>;
  source: FactSource;
  readers: Readers;
  /** World time: when it became true / stopped being true. */
  validFrom: number;
  validTo?: number;
  /** Transaction time: when we learned it / when a re-assert retracted it. */
  recordedAt: number;
  invalidatedAt?: number;
}

export interface FactInput {
  type: FactType;
  from: string;
  to: string;
  attrs?: Record<string, unknown>;
  readers?: Readers;
  validFrom?: number;
}

export interface AssertReport {
  source: FactSource;
  added: number;
  unchanged: number;
  invalidated: number;
}

export type Direction = "out" | "in" | "both";

export interface NeighborQuery {
  entityId: string;
  direction?: Direction;
  factTypes?: FactType[];
  /** 1 by default, capped at 4. */
  depth?: number;
  /** Graph as of this world time; default now (current facts only). */
  asOf?: number;
  audience: Audience;
  limit?: number;
}

export interface Subgraph {
  entities: Entity[];
  facts: Fact[];
}

// ── Documents ───────────────────────────────────────────────────────────────

export interface Document {
  /** Stable per source location, e.g. `doc:frak-id/atelier:docs/x.md#setup`. */
  id: string;
  /** Collection key, replaced as a set by the indexer (`repo:frak-id/atelier`). */
  collection: string;
  title: string;
  body: string;
  /** Path within the source, for citations. */
  path?: string;
  url?: string;
  /** Revision the text was taken at (commit sha). */
  revision?: string;
  entityIds: string[];
  readers: Readers;
  /** Content hash, lets re-indexing skip unchanged chunks. */
  hash: string;
  updatedAt: number;
}

export type DocumentInput = Omit<Document, "updatedAt">;

// ── Search ──────────────────────────────────────────────────────────────────

export type SearchKind = "memory" | "entity" | "document";

export interface SearchQuery {
  text: string;
  audience: Audience;
  kinds?: SearchKind[];
  limit?: number;
  /** Memory statuses to include (default `["active"]`). */
  memoryStatus?: MemoryStatus[];
  /** Restrict to records linked to this entity. */
  entityId?: string;
}

export interface SearchHit {
  kind: SearchKind;
  id: string;
  title: string;
  snippet: string;
  /** Fused score, higher is better; only comparable within one result set. */
  score: number;
  /** Which retrievers matched: `fts`, `vector`. */
  matchedBy: ("fts" | "vector")[];
  entityIds: string[];
  provenance?: Provenance[];
  url?: string;
}

/** Pluggable text embedder. Vectors must be L2-normalised. */
export interface Embedder {
  /** Stored with each vector; changing it re-embeds. */
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

// ── Code indexer ───────────────────────────────────────────────────────────

export interface IndexRepositoryInput {
  /** Checkout on disk. */
  root: string;
  /** `owner/name`. */
  repo: string;
  /** Commit sha (or any revision label) of the checkout. */
  revision: string;
  /** Default `[ORG_PRINCIPAL]`; private repos should pass narrower readers. */
  readers?: Readers;
  /** Base URL for citations, e.g. `https://github.com/owner/name/blob/<rev>`. */
  webUrl?: string;
  /** Emit one `file` entity per source file (default false: packages only). */
  includeFiles?: boolean;
  /** Emit `dependency` entities for external packages (default false). */
  includeExternalDeps?: boolean;
}

/**
 * Pure extraction output: what a repository says about itself at one
 * revision. Applying it to the stores is a separate step (`applyIndex`), so
 * extraction can run anywhere (a sandbox, CI) and ship its result as JSON.
 */
export interface RepositoryIndex {
  repo: string;
  revision: string;
  entities: EntityInput[];
  facts: FactInput[];
  documents: DocumentInput[];
  /** Non-fatal problems (unparseable manifest, …). */
  warnings: string[];
  stats: {
    files: number;
    packages: number;
    documents: number;
    durationMs: number;
  };
}

// ── Store interfaces (implemented in graph/ and documents/) ─────────────────

export interface EntityFilter {
  audience: Audience;
  type?: EntityType;
  /** Entities last asserted by this source. */
  sourceKey?: string;
  includeRetired?: boolean;
  limit?: number;
  offset?: number;
}

export interface GraphStore {
  /**
   * Inserts or updates entities (by id). `sourceKey` records who asserted
   * them (last writer wins, see the proposal's known limitations) and
   * un-retires a previously retired entity.
   */
  upsertEntities(
    entities: EntityInput[],
    opts?: { sourceKey?: string },
  ): number;
  /**
   * Retires the source's entities whose id is not in `keepIds` (sets
   * `retiredAt`, never deletes). Returns how many were retired.
   */
  retireEntities(sourceKey: string, keepIds: string[]): number;
  /** Unfiltered by audience: callers enforce access. */
  getEntity(id: string): Entity | undefined;
  listEntities(filter: EntityFilter): Entity[];
  /**
   * Replaces the fact set of `source.key`: facts not currently valid are
   * inserted, identical current facts are left alone, current facts of the
   * source absent from `facts` are invalidated (`validTo` and
   * `invalidatedAt` = now). Identity is (type, from, to, attrs, readers).
   */
  assertFacts(
    source: FactSource,
    facts: FactInput[],
    opts?: { now?: number },
  ): AssertReport;
  /**
   * Invalidates every current fact of a source, or deletes all of its facts
   * (history included) with `hard` — the erasure path. Returns the count.
   */
  retractSource(sourceKey: string, opts?: { hard?: boolean }): number;
  /** Facts touching an entity, visible to the audience. */
  factsFor(
    entityId: string,
    opts: {
      audience: Audience;
      direction?: Direction;
      asOf?: number;
      /** Include invalidated facts (full history). */
      includeHistory?: boolean;
    },
  ): Fact[];
  /** Breadth-first expansion; only visible entities and facts. */
  neighbors(query: NeighborQuery): Subgraph;
}

export interface DocumentStore {
  /**
   * Makes `collection` hold exactly `docs`: unchanged hashes are skipped,
   * changed/new ones written, missing ones deleted (with their embeddings).
   */
  replaceCollection(
    collection: string,
    docs: DocumentInput[],
  ): { upserted: number; unchanged: number; removed: number };
  /** Unfiltered by audience: callers enforce access. */
  get(id: string): Document | undefined;
  list(
    collection: string,
    opts?: { limit?: number; offset?: number },
  ): Document[];
  collections(): { collection: string; count: number; updatedAt: number }[];
}

export interface ApplyIndexReport {
  repo: string;
  revision: string;
  entities: { upserted: number; retired: number };
  facts: AssertReport;
  documents: { upserted: number; unchanged: number; removed: number };
}
