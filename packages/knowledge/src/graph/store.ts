/**
 * The temporal knowledge graph: entities (derived from the indexer or
 * approved memories) and facts (bi-temporal edges between entity ids).
 * Re-asserting a source's fact set invalidates what it no longer states
 * instead of deleting history — see `types.ts#GraphStore` for the contract.
 */
import type { Database } from "bun:sqlite";
import type {
  AccessResolver,
  AssertReport,
  Audience,
  Direction,
  Entity,
  EntityFilter,
  EntityInput,
  Fact,
  FactInput,
  FactSource,
  FactType,
  GraphStore,
  NeighborQuery,
  Readers,
  Subgraph,
} from "../types.ts";
import {
  canonicalJson,
  defaultAccessResolver,
  isVisible,
  newId,
  opt,
  parseJson,
  sha256,
} from "../util.ts";

interface EntityRow {
  id: string;
  type: string;
  name: string;
  summary: string | null;
  attrs: string;
  readers: string;
  source_key: string | null;
  retired_at: number | null;
  created_at: number;
  updated_at: number;
}

interface FactRow {
  id: string;
  type: string;
  from_id: string;
  to_id: string;
  attrs: string;
  fingerprint: string;
  source_key: string;
  source_revision: string | null;
  readers: string;
  valid_from: number;
  valid_to: number | null;
  recorded_at: number;
  invalidated_at: number | null;
}

function mapEntity(row: EntityRow): Entity {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    summary: opt(row.summary),
    attrs: parseJson(row.attrs, {}),
    readers: parseJson(row.readers, []),
    sourceKey: opt(row.source_key),
    retiredAt: opt(row.retired_at),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapFact(row: FactRow): Fact {
  return {
    id: row.id,
    type: row.type,
    from: row.from_id,
    to: row.to_id,
    attrs: parseJson(row.attrs, {}),
    source: { key: row.source_key, revision: opt(row.source_revision) },
    readers: parseJson(row.readers, []),
    validFrom: row.valid_from,
    validTo: opt(row.valid_to),
    recordedAt: row.recorded_at,
    invalidatedAt: opt(row.invalidated_at),
  };
}

/** Fingerprint identity for fact dedup/diffing: `(type, from, to, attrs, readers)`. */
function fingerprint(
  type: FactType,
  from: string,
  to: string,
  attrs: Record<string, unknown>,
  readers: Readers,
): string {
  return sha256(
    canonicalJson({ type, from, to, attrs, readers: [...readers].sort() }),
  );
}

export interface SqliteGraphStoreOptions {
  access?: AccessResolver;
  clock?: () => number;
}

export class SqliteGraphStore implements GraphStore {
  private readonly access: AccessResolver;
  private readonly clock: () => number;

  constructor(
    private readonly db: Database,
    opts: SqliteGraphStoreOptions = {},
  ) {
    this.access = opts.access ?? defaultAccessResolver;
    this.clock = opts.clock ?? (() => Date.now());
  }

  upsertEntities(
    entities: EntityInput[],
    opts: { sourceKey?: string } = {},
  ): number {
    const now = this.clock();
    const stmt = this.db.query(
      `INSERT INTO entities
         (id, type, name, summary, attrs, readers, source_key,
          retired_at, created_at, updated_at)
       VALUES
         ($id, $type, $name, $summary, $attrs, $readers, $sourceKey,
          NULL, $now, $now)
       ON CONFLICT(id) DO UPDATE SET
         type = excluded.type,
         name = excluded.name,
         summary = excluded.summary,
         attrs = excluded.attrs,
         readers = excluded.readers,
         source_key = coalesce($sourceKey, entities.source_key),
         retired_at = NULL,
         updated_at = $now`,
    );
    this.db.transaction(() => {
      for (const entity of entities) {
        stmt.run({
          id: entity.id,
          type: entity.type,
          name: entity.name,
          summary: entity.summary ?? null,
          attrs: JSON.stringify(entity.attrs),
          readers: JSON.stringify(entity.readers),
          sourceKey: opts.sourceKey ?? null,
          now,
        });
      }
    })();
    return entities.length;
  }

  retireEntities(sourceKey: string, keepIds: string[]): number {
    const now = this.clock();
    if (keepIds.length === 0) {
      const result = this.db
        .query(
          `UPDATE entities SET retired_at = $now
           WHERE source_key = $sourceKey AND retired_at IS NULL`,
        )
        .run({ sourceKey, now });
      return result.changes;
    }
    const placeholders = keepIds.map((_, i) => `$keep${i}`).join(", ");
    const params: Record<string, string | number> = { sourceKey, now };
    keepIds.forEach((id, i) => {
      params[`keep${i}`] = id;
    });
    const result = this.db
      .query(
        `UPDATE entities SET retired_at = $now
         WHERE source_key = $sourceKey AND retired_at IS NULL
           AND id NOT IN (${placeholders})`,
      )
      .run(params);
    return result.changes;
  }

  getEntity(id: string): Entity | undefined {
    const row = this.db
      .query("SELECT * FROM entities WHERE id = $id")
      .get({ id }) as EntityRow | null;
    return row ? mapEntity(row) : undefined;
  }

  listEntities(filter: EntityFilter): Entity[] {
    const limit = filter.limit ?? 200;
    const offset = filter.offset ?? 0;
    const pageSize = Math.max(limit * 5, 50);
    const conditions: string[] = [];
    const params: Record<string, string | number> = {};
    if (filter.type !== undefined) {
      conditions.push("type = $type");
      params.type = filter.type;
    }
    if (filter.sourceKey !== undefined) {
      conditions.push("source_key = $sourceKey");
      params.sourceKey = filter.sourceKey;
    }
    if (!filter.includeRetired) {
      conditions.push("retired_at IS NULL");
    }
    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const result: Entity[] = [];
    let skipped = 0;
    let dbOffset = 0;
    for (;;) {
      const rows = this.db
        .query(
          `SELECT * FROM entities ${where}
           ORDER BY created_at, id
           LIMIT $limit OFFSET $offset`,
        )
        .all({ ...params, limit: pageSize, offset: dbOffset }) as EntityRow[];
      if (rows.length === 0) break;
      for (const row of rows) {
        const entity = mapEntity(row);
        if (!isVisible(entity.readers, filter.audience, this.access)) {
          continue;
        }
        if (skipped < offset) {
          skipped++;
          continue;
        }
        result.push(entity);
        if (result.length >= limit) break;
      }
      dbOffset += rows.length;
      if (result.length >= limit || rows.length < pageSize) break;
    }
    return result;
  }

  assertFacts(
    source: FactSource,
    facts: FactInput[],
    opts: { now?: number } = {},
  ): AssertReport {
    const now = opts.now ?? this.clock();
    const deduped = new Map<
      string,
      { input: FactInput; readers: Readers; attrs: Record<string, unknown> }
    >();
    for (const input of facts) {
      const readers = input.readers ?? ["org"];
      const attrs = input.attrs ?? {};
      const fp = fingerprint(input.type, input.from, input.to, attrs, readers);
      if (!deduped.has(fp)) deduped.set(fp, { input, readers, attrs });
    }

    const currentRows = this.db
      .query(
        `SELECT * FROM facts
         WHERE source_key = $sourceKey AND invalidated_at IS NULL`,
      )
      .all({ sourceKey: source.key }) as FactRow[];
    const current = new Map(currentRows.map((row) => [row.fingerprint, row]));

    let added = 0;
    let unchanged = 0;
    let invalidated = 0;

    const insert = this.db.query(
      `INSERT INTO facts
         (id, type, from_id, to_id, attrs, fingerprint, source_key,
          source_revision, readers, valid_from, valid_to, recorded_at,
          invalidated_at)
       VALUES
         ($id, $type, $from, $to, $attrs, $fingerprint, $sourceKey,
          $sourceRevision, $readers, $validFrom, NULL, $recordedAt, NULL)`,
    );
    const invalidate = this.db.query(
      `UPDATE facts SET valid_to = $now, invalidated_at = $now
       WHERE id = $id`,
    );

    this.db.transaction(() => {
      for (const [fp, { input, readers, attrs }] of deduped) {
        const existing = current.get(fp);
        if (existing) {
          current.delete(fp);
          unchanged++;
          continue;
        }
        insert.run({
          id: newId("fact"),
          type: input.type,
          from: input.from,
          to: input.to,
          attrs: JSON.stringify(attrs),
          fingerprint: fp,
          sourceKey: source.key,
          sourceRevision: source.revision ?? null,
          readers: JSON.stringify(readers),
          validFrom: input.validFrom ?? now,
          recordedAt: now,
        });
        added++;
      }
      for (const row of current.values()) {
        invalidate.run({ id: row.id, now });
        invalidated++;
      }
    })();

    return { source, added, unchanged, invalidated };
  }

  retractSource(sourceKey: string, opts: { hard?: boolean } = {}): number {
    const now = this.clock();
    if (opts.hard) {
      const result = this.db
        .query("DELETE FROM facts WHERE source_key = $sourceKey")
        .run({ sourceKey });
      return result.changes;
    }
    const result = this.db
      .query(
        `UPDATE facts SET valid_to = $now, invalidated_at = $now
         WHERE source_key = $sourceKey AND invalidated_at IS NULL`,
      )
      .run({ sourceKey, now });
    return result.changes;
  }

  factsFor(
    entityId: string,
    opts: {
      audience: Audience;
      direction?: Direction;
      asOf?: number;
      includeHistory?: boolean;
    },
  ): Fact[] {
    const rows = this.queryFactsTouching(
      entityId,
      opts.direction ?? "both",
      undefined,
      opts.includeHistory ? undefined : opts.asOf,
      opts.includeHistory ? undefined : this.clock(),
      opts.includeHistory ?? false,
    );
    return rows
      .map(mapFact)
      .filter((fact) => isVisible(fact.readers, opts.audience, this.access));
  }

  neighbors(query: NeighborQuery): Subgraph {
    const depth = Math.min(query.depth ?? 1, 4);
    const direction = query.direction ?? "both";
    const limit = query.limit ?? 200;
    const asOf = query.asOf;
    const now = this.clock();

    const entitiesById = new Map<string, Entity>();
    const factsById = new Map<string, Fact>();
    let currentFrontier = [query.entityId];

    for (let d = 0; d < depth; d++) {
      if (currentFrontier.length === 0) break;
      const nextFrontier: string[] = [];
      for (const nodeId of currentFrontier) {
        const rows = this.queryFactsTouching(
          nodeId,
          direction,
          query.factTypes,
          asOf,
          now,
          false,
        );
        for (const row of rows) {
          const fact = mapFact(row);
          if (!isVisible(fact.readers, query.audience, this.access)) {
            continue;
          }
          factsById.set(fact.id, fact);
          const otherId = fact.from === nodeId ? fact.to : fact.from;
          if (otherId === query.entityId) continue;
          if (entitiesById.has(otherId)) continue;
          if (entitiesById.size >= limit) continue;
          const entity = this.getEntity(otherId);
          if (!entity) continue; // no row: fact kept, no traversal
          if (!asOf && entity.retiredAt) continue;
          if (!isVisible(entity.readers, query.audience, this.access)) {
            continue;
          }
          entitiesById.set(otherId, entity);
          nextFrontier.push(otherId);
        }
      }
      currentFrontier = nextFrontier;
    }

    return {
      entities: [...entitiesById.values()],
      facts: [...factsById.values()],
    };
  }

  /** Raw fact rows touching `nodeId`, time-filtered but not ACL-filtered. */
  private queryFactsTouching(
    nodeId: string,
    direction: Direction,
    factTypes: FactType[] | undefined,
    asOf: number | undefined,
    now: number | undefined,
    includeHistory = false,
  ): FactRow[] {
    const conditions: string[] = [];
    const params: Record<string, string | number> = { nodeId };

    if (direction === "out") {
      conditions.push("from_id = $nodeId");
    } else if (direction === "in") {
      conditions.push("to_id = $nodeId");
    } else {
      conditions.push("(from_id = $nodeId OR to_id = $nodeId)");
    }

    if (factTypes && factTypes.length > 0) {
      const placeholders = factTypes.map((_, i) => `$type${i}`).join(", ");
      factTypes.forEach((type, i) => {
        params[`type${i}`] = type;
      });
      conditions.push(`type IN (${placeholders})`);
    }

    if (!includeHistory) {
      if (asOf !== undefined) {
        conditions.push(
          "valid_from <= $asOf AND (valid_to IS NULL OR valid_to > $asOf)",
        );
        params.asOf = asOf;
      } else {
        conditions.push(
          "invalidated_at IS NULL AND (valid_to IS NULL OR valid_to > $now)",
        );
        // Callers only omit `now` together with `includeHistory`, handled
        // above; reaching here means it was provided.
        params.now = now ?? Date.now();
      }
    }

    return this.db
      .query(`SELECT * FROM facts WHERE ${conditions.join(" AND ")}`)
      .all(params) as FactRow[];
  }
}
