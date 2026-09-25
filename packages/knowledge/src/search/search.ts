/**
 * Audience-scoped hybrid search: FTS5 (bm25) and, when an embedder is
 * configured, brute-force vector similarity, fused with Reciprocal Rank
 * Fusion. Visibility is enforced in-process (over-fetch, then filter) so
 * ACL-hidden hits don't starve the result page.
 */
import type { Database } from "bun:sqlite";
import { ValidationError } from "../errors.ts";
import type {
  AccessResolver,
  Embedder,
  MemoryStatus,
  Provenance,
  Readers,
  SearchHit,
  SearchKind,
  SearchQuery,
} from "../types.ts";
import {
  defaultAccessResolver,
  isVisible,
  opt,
  parseJson,
  sha256,
} from "../util.ts";

const RRF_K = 60;

interface Candidate {
  kind: SearchKind;
  id: string;
  readers: Readers;
  entityIds: string[];
  title: string;
  snippet: string;
  provenance?: Provenance[];
  url?: string;
  ftsRank?: number;
  vectorRank?: number;
}

function truncate(text: string, length = 200): string {
  const trimmed = text.trim();
  return trimmed.length > length ? `${trimmed.slice(0, length)}…` : trimmed;
}

function memoryTitle(content: string): string {
  const firstLine = content.split("\n")[0] ?? "";
  return truncate(firstLine, 80);
}

/**
 * Turns free text into a safe FTS5 MATCH expression: only alphanumeric
 * word tokens survive (raw operators, `NEAR(`, unbalanced quotes, `*`, …
 * are never passed through), each token is quoted, OR-joined, and the
 * last one gets a prefix match. Returns `undefined` for no usable tokens.
 */
export function buildFtsQuery(text: string): string | undefined {
  const words = text.toLowerCase().match(/[a-z0-9]+/g);
  if (!words || words.length === 0) return undefined;
  const quoted = words.map((w) => `"${w}"`);
  const lastIndex = quoted.length - 1;
  quoted[lastIndex] = `${quoted[lastIndex]}*`;
  return quoted.join(" OR ");
}

function vectorToBytes(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

function bytesToVector(bytes: Uint8Array): Float32Array {
  const copy = bytes.slice().buffer;
  return new Float32Array(copy);
}

/** Assumes both vectors are L2-normalised (the `Embedder` contract). */
function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}

export interface KnowledgeSearchOptions {
  embedder?: Embedder;
  access?: AccessResolver;
}

export class KnowledgeSearch {
  private readonly embedder: Embedder | undefined;
  private readonly access: AccessResolver;

  constructor(
    private readonly db: Database,
    opts: KnowledgeSearchOptions = {},
  ) {
    this.embedder = opts.embedder;
    this.access = opts.access ?? defaultAccessResolver;
  }

  async search(query: SearchQuery): Promise<SearchHit[]> {
    if (query.audience.length === 0) {
      throw new ValidationError("search requires a non-empty audience");
    }
    const kinds = query.kinds ?? (["memory", "entity", "document"] as const);
    const limit = query.limit ?? 20;
    const overFetch = Math.max(limit * 5, 50);
    const statuses = query.memoryStatus ?? ["active"];

    const candidates = new Map<string, Candidate>();

    const ftsQuery = buildFtsQuery(query.text);
    if (ftsQuery) {
      for (const kind of kinds) {
        const rows = this.ftsSearch(kind, ftsQuery, overFetch, statuses);
        rows.forEach((candidate, rank) => {
          const key = `${kind}:${candidate.id}`;
          candidate.ftsRank = rank;
          const existing = candidates.get(key);
          candidates.set(
            key,
            existing ? { ...existing, ftsRank: rank } : candidate,
          );
        });
      }
    }

    if (this.embedder) {
      const [queryVector] = await this.embedder.embed([query.text]);
      if (queryVector) {
        for (const kind of kinds) {
          const rows = this.vectorSearch(
            kind,
            queryVector,
            overFetch,
            statuses,
          );
          rows.forEach((candidate, rank) => {
            const key = `${kind}:${candidate.id}`;
            const existing = candidates.get(key);
            if (existing) {
              existing.vectorRank = rank;
            } else {
              candidate.vectorRank = rank;
              candidates.set(key, candidate);
            }
          });
        }
      }
    }

    const scored = [...candidates.values()].map((candidate) => {
      const matchedBy: ("fts" | "vector")[] = [];
      let score = 0;
      if (candidate.ftsRank !== undefined) {
        score += 1 / (RRF_K + candidate.ftsRank + 1);
        matchedBy.push("fts");
      }
      if (candidate.vectorRank !== undefined) {
        score += 1 / (RRF_K + candidate.vectorRank + 1);
        matchedBy.push("vector");
      }
      return { candidate, score, matchedBy };
    });
    scored.sort((a, b) => b.score - a.score);

    const hits: SearchHit[] = [];
    for (const { candidate, score, matchedBy } of scored) {
      if (!isVisible(candidate.readers, query.audience, this.access)) {
        continue;
      }
      if (query.entityId && !this.matchesEntity(candidate, query.entityId)) {
        continue;
      }
      hits.push({
        kind: candidate.kind,
        id: candidate.id,
        title: candidate.title,
        snippet: candidate.snippet,
        score,
        matchedBy,
        entityIds: candidate.entityIds,
        provenance: candidate.provenance,
        url: candidate.url,
      });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  /** A no-op without an embedder: FTS-only search has nothing to embed. */
  async embedPending(
    opts: { kinds?: SearchKind[]; batchSize?: number } = {},
  ): Promise<{ embedded: number; skipped: number }> {
    const embedder = this.embedder;
    if (!embedder) return { embedded: 0, skipped: 0 };
    const kinds = opts.kinds ?? (["memory", "entity", "document"] as const);
    const batchSize = opts.batchSize ?? 32;

    type Pending = { ownerKind: SearchKind; ownerId: string; text: string };
    const pending: Pending[] = [];
    let skipped = 0;

    for (const kind of kinds) {
      for (const { id, text } of this.embeddableText(kind)) {
        const hash = sha256(text);
        const existing = this.db
          .query(
            `SELECT content_hash FROM embeddings
             WHERE owner_kind = $kind AND owner_id = $id AND model = $model`,
          )
          .get({ kind, id, model: embedder.model }) as {
          content_hash: string;
        } | null;
        if (existing && existing.content_hash === hash) {
          skipped++;
          continue;
        }
        pending.push({ ownerKind: kind, ownerId: id, text });
      }
    }

    let embedded = 0;
    const upsert = this.db.query(
      `INSERT INTO embeddings
         (owner_kind, owner_id, model, dimensions, vector, content_hash,
          created_at)
       VALUES
         ($ownerKind, $ownerId, $model, $dimensions, $vector, $hash, $now)
       ON CONFLICT(owner_kind, owner_id, model) DO UPDATE SET
         dimensions = excluded.dimensions,
         vector = excluded.vector,
         content_hash = excluded.content_hash,
         created_at = excluded.created_at`,
    );

    for (let start = 0; start < pending.length; start += batchSize) {
      const batch = pending.slice(start, start + batchSize);
      const vectors = await embedder.embed(batch.map((p) => p.text));
      this.db.transaction(() => {
        batch.forEach((item, i) => {
          const vector = vectors[i];
          if (!vector) return;
          upsert.run({
            ownerKind: item.ownerKind,
            ownerId: item.ownerId,
            model: embedder.model,
            dimensions: vector.length,
            vector: vectorToBytes(vector),
            hash: sha256(item.text),
            now: Date.now(),
          });
          embedded++;
        });
      })();
    }

    return { embedded, skipped };
  }

  // ── retrieval ────────────────────────────────────────────────────────────

  private matchesEntity(candidate: Candidate, entityId: string): boolean {
    if (candidate.kind === "entity") return candidate.id === entityId;
    return candidate.entityIds.includes(entityId);
  }

  private ftsSearch(
    kind: SearchKind,
    ftsQuery: string,
    limit: number,
    statuses: MemoryStatus[],
  ): Candidate[] {
    if (kind === "memory") return this.ftsMemories(ftsQuery, limit, statuses);
    if (kind === "entity") return this.ftsEntities(ftsQuery, limit);
    return this.ftsDocuments(ftsQuery, limit);
  }

  private vectorSearch(
    kind: SearchKind,
    queryVector: Float32Array,
    limit: number,
    statuses: MemoryStatus[],
  ): Candidate[] {
    if (kind === "memory") {
      return this.vectorMemories(queryVector, limit, statuses);
    }
    if (kind === "entity") return this.vectorEntities(queryVector, limit);
    return this.vectorDocuments(queryVector, limit);
  }

  private ftsMemories(
    ftsQuery: string,
    limit: number,
    statuses: MemoryStatus[],
  ): Candidate[] {
    const placeholders = statuses.map((_, i) => `$status${i}`).join(", ");
    const params: Record<string, string | number> = { q: ftsQuery, limit };
    statuses.forEach((s, i) => {
      params[`status${i}`] = s;
    });
    const rows = this.db
      .query(
        `SELECT m.id, m.content, m.tags, m.readers, m.entity_ids,
                m.provenance,
                snippet(memories_fts, 0, '', '', '…', 12) AS snippet
         FROM memories_fts
         JOIN memories m ON m.rowid = memories_fts.rowid
         WHERE memories_fts MATCH $q AND m.status IN (${placeholders})
         ORDER BY bm25(memories_fts)
         LIMIT $limit`,
      )
      .all(params) as {
      id: string;
      content: string;
      tags: string;
      readers: string;
      entity_ids: string;
      provenance: string;
      snippet: string;
    }[];
    return rows.map((row) => ({
      kind: "memory" as const,
      id: row.id,
      readers: parseJson(row.readers, []),
      entityIds: parseJson(row.entity_ids, []),
      title: memoryTitle(row.content),
      snippet: row.snippet || truncate(row.content),
      provenance: parseJson(row.provenance, []),
    }));
  }

  private ftsEntities(ftsQuery: string, limit: number): Candidate[] {
    const rows = this.db
      .query(
        `SELECT e.id, e.type, e.name, e.summary, e.readers,
                snippet(entities_fts, 2, '', '', '…', 12) AS snippet
         FROM entities_fts
         JOIN entities e ON e.rowid = entities_fts.rowid
         WHERE entities_fts MATCH $q AND e.retired_at IS NULL
         ORDER BY bm25(entities_fts)
         LIMIT $limit`,
      )
      .all({ q: ftsQuery, limit }) as {
      id: string;
      type: string;
      name: string;
      summary: string | null;
      readers: string;
      snippet: string;
    }[];
    return rows.map((row) => ({
      kind: "entity" as const,
      id: row.id,
      readers: parseJson(row.readers, []),
      entityIds: [row.id],
      title: `${row.name} (${row.type})`,
      snippet: row.snippet || truncate(row.summary ?? ""),
    }));
  }

  private ftsDocuments(ftsQuery: string, limit: number): Candidate[] {
    const rows = this.db
      .query(
        `SELECT d.id, d.title, d.body, d.url, d.entity_ids, d.readers,
                snippet(documents_fts, 1, '', '', '…', 20) AS snippet
         FROM documents_fts
         JOIN documents d ON d.rowid = documents_fts.rowid
         WHERE documents_fts MATCH $q
         ORDER BY bm25(documents_fts)
         LIMIT $limit`,
      )
      .all({ q: ftsQuery, limit }) as {
      id: string;
      title: string;
      body: string;
      url: string | null;
      entity_ids: string;
      readers: string;
      snippet: string;
    }[];
    return rows.map((row) => ({
      kind: "document" as const,
      id: row.id,
      readers: parseJson(row.readers, []),
      entityIds: parseJson(row.entity_ids, []),
      title: row.title,
      snippet: row.snippet || truncate(row.body),
      url: opt(row.url),
    }));
  }

  private vectorMemories(
    queryVector: Float32Array,
    limit: number,
    statuses: MemoryStatus[],
  ): Candidate[] {
    if (!this.embedder) return [];
    const placeholders = statuses.map((_, i) => `$status${i}`).join(", ");
    const params: Record<string, string> = { model: this.embedder.model };
    statuses.forEach((s, i) => {
      params[`status${i}`] = s;
    });
    const rows = this.db
      .query(
        `SELECT m.id, m.content, m.readers, m.entity_ids, m.provenance,
                em.vector AS vector
         FROM embeddings em
         JOIN memories m ON m.id = em.owner_id
         WHERE em.owner_kind = 'memory' AND em.model = $model
           AND m.status IN (${placeholders})`,
      )
      .all(params) as {
      id: string;
      content: string;
      readers: string;
      entity_ids: string;
      provenance: string;
      vector: Uint8Array;
    }[];
    return this.rankByVector(rows, queryVector, limit).map((row) => ({
      kind: "memory" as const,
      id: row.id,
      readers: parseJson(row.readers, []),
      entityIds: parseJson(row.entity_ids, []),
      title: memoryTitle(row.content),
      snippet: truncate(row.content),
      provenance: parseJson(row.provenance, []),
    }));
  }

  private vectorEntities(
    queryVector: Float32Array,
    limit: number,
  ): Candidate[] {
    if (!this.embedder) return [];
    const rows = this.db
      .query(
        `SELECT e.id, e.type, e.name, e.summary, e.readers,
                em.vector AS vector
         FROM embeddings em
         JOIN entities e ON e.id = em.owner_id
         WHERE em.owner_kind = 'entity' AND em.model = $model
           AND e.retired_at IS NULL`,
      )
      .all({ model: this.embedder.model }) as {
      id: string;
      type: string;
      name: string;
      summary: string | null;
      readers: string;
      vector: Uint8Array;
    }[];
    return this.rankByVector(rows, queryVector, limit).map((row) => ({
      kind: "entity" as const,
      id: row.id,
      readers: parseJson(row.readers, []),
      entityIds: [row.id],
      title: `${row.name} (${row.type})`,
      snippet: truncate(row.summary ?? ""),
    }));
  }

  private vectorDocuments(
    queryVector: Float32Array,
    limit: number,
  ): Candidate[] {
    if (!this.embedder) return [];
    const rows = this.db
      .query(
        `SELECT d.id, d.title, d.body, d.url, d.entity_ids, d.readers,
                em.vector AS vector
         FROM embeddings em
         JOIN documents d ON d.id = em.owner_id
         WHERE em.owner_kind = 'document' AND em.model = $model`,
      )
      .all({ model: this.embedder.model }) as {
      id: string;
      title: string;
      body: string;
      url: string | null;
      entity_ids: string;
      readers: string;
      vector: Uint8Array;
    }[];
    return this.rankByVector(rows, queryVector, limit).map((row) => ({
      kind: "document" as const,
      id: row.id,
      readers: parseJson(row.readers, []),
      entityIds: parseJson(row.entity_ids, []),
      title: row.title,
      snippet: truncate(row.body),
      url: opt(row.url),
    }));
  }

  private rankByVector<T extends { vector: Uint8Array }>(
    rows: T[],
    queryVector: Float32Array,
    limit: number,
  ): T[] {
    return rows
      .map((row) => ({
        row,
        score: dot(bytesToVector(row.vector), queryVector),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((r) => r.row);
  }

  /** Text embedded for each kind, and the ids it's embedded for. */
  private embeddableText(kind: SearchKind): { id: string; text: string }[] {
    if (kind === "memory") {
      const rows = this.db
        .query(
          `SELECT id, content, tags FROM memories
           WHERE status IN ('proposed', 'active', 'stale')`,
        )
        .all() as { id: string; content: string; tags: string }[];
      return rows.map((row) => ({
        id: row.id,
        text: `${row.content} ${parseJson<string[]>(row.tags, []).join(" ")}`,
      }));
    }
    if (kind === "entity") {
      const rows = this.db
        .query(
          `SELECT id, name, summary FROM entities WHERE retired_at IS NULL`,
        )
        .all() as { id: string; name: string; summary: string | null }[];
      return rows.map((row) => ({
        id: row.id,
        text: `${row.name} ${row.summary ?? ""}`,
      }));
    }
    const rows = this.db
      .query(`SELECT id, title, body FROM documents`)
      .all() as { id: string; title: string; body: string }[];
    return rows.map((row) => ({
      id: row.id,
      text: `${row.title} ${row.body}`,
    }));
  }
}
