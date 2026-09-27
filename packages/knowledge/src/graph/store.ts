/**
 * The temporal knowledge graph: entities (derived from the indexer or
 * approved memories) and facts (bi-temporal edges between entity ids).
 * Re-asserting a source's fact set invalidates what it no longer states
 * instead of deleting history — see `types.ts#GraphStore` for the contract.
 */
import type { Database } from "bun:sqlite";
import type {
  AssertReport,
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
  Subgraph,
} from "../types.ts";
import { canonicalJson, newId, opt, parseJson, sha256 } from "../util.ts";

interface EntityRow {
  id: string;
  type: string;
  name: string;
  summary: string | null;
  attrs: string;
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
    validFrom: row.valid_from,
    validTo: opt(row.valid_to),
    recordedAt: row.recorded_at,
    invalidatedAt: opt(row.invalidated_at),
  };
}

/** Fingerprint identity for fact dedup/diffing: `(type, from, to, attrs)`. */
function fingerprint(
  type: FactType,
  from: string,
  to: string,
  attrs: Record<string, unknown>,
): string {
  return sha256(canonicalJson({ type, from, to, attrs }));
}

export interface SqliteGraphStoreOptions {
  clock?: () => number;
}

export class SqliteGraphStore implements GraphStore {
  private readonly clock: () => number;

  constructor(
    private readonly db: Database,
    opts: SqliteGraphStoreOptions = {},
  ) {
    this.clock = opts.clock ?? (() => Date.now());
  }

  upsertEntities(
    entities: EntityInput[],
    opts: { sourceKey?: string } = {},
  ): number {
    const now = this.clock();
    const stmt = this.db.query(
      `INSERT INTO entities
         (id, type, name, summary, attrs, source_key,
          retired_at, created_at, updated_at)
       VALUES
         ($id, $type, $name, $summary, $attrs, $sourceKey,
          NULL, $now, $now)
       ON CONFLICT(id) DO UPDATE SET
         type = excluded.type,
         name = excluded.name,
         summary = excluded.summary,
         attrs = excluded.attrs,
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
    // One JSON parameter, not one bind per id: an index with
    // `includeFiles` can keep tens of thousands of entities, past sqlite's
    // bind-parameter limit.
    const result = this.db
      .query(
        `UPDATE entities SET retired_at = $now
         WHERE source_key = $sourceKey AND retired_at IS NULL
           AND id NOT IN (SELECT value FROM json_each($keep))`,
      )
      .run({ sourceKey, now, keep: JSON.stringify(keepIds) });
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

    const rows = this.db
      .query(
        `SELECT * FROM entities ${where}
         ORDER BY created_at, id
         LIMIT $limit OFFSET $offset`,
      )
      .all({ ...params, limit, offset }) as EntityRow[];
    return rows.map(mapEntity);
  }

  assertFacts(
    source: FactSource,
    facts: FactInput[],
    opts: { now?: number } = {},
  ): AssertReport {
    const now = opts.now ?? this.clock();
    const deduped = new Map<
      string,
      { input: FactInput; attrs: Record<string, unknown> }
    >();
    for (const input of facts) {
      const attrs = input.attrs ?? {};
      const fp = fingerprint(input.type, input.from, input.to, attrs);
      if (!deduped.has(fp)) deduped.set(fp, { input, attrs });
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
          source_revision, valid_from, valid_to, recorded_at,
          invalidated_at)
       VALUES
         ($id, $type, $from, $to, $attrs, $fingerprint, $sourceKey,
          $sourceRevision, $validFrom, NULL, $recordedAt, NULL)`,
    );
    const invalidate = this.db.query(
      `UPDATE facts SET valid_to = $now, invalidated_at = $now
       WHERE id = $id`,
    );

    this.db.transaction(() => {
      for (const [fp, { input, attrs }] of deduped) {
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
      direction?: Direction;
      asOf?: number;
      includeHistory?: boolean;
    } = {},
  ): Fact[] {
    const rows = this.queryFactsTouching(
      entityId,
      opts.direction ?? "both",
      undefined,
      opts.includeHistory ? undefined : opts.asOf,
      opts.includeHistory ? undefined : this.clock(),
      opts.includeHistory ?? false,
    );
    return rows.map(mapFact);
  }

  neighbors(query: NeighborQuery): Subgraph {
    const depth = Math.min(query.depth ?? 1, 4);
    const direction = query.direction ?? "both";
    const limit = Math.min(query.limit ?? 200, 1000);
    // Facts are capped too: one high fan-out node (a team owning hundreds
    // of packages) must not make a depth-1 query unbounded.
    const factLimit = limit * 4;
    const asOf = query.asOf;
    const now = this.clock();

    const entitiesById = new Map<string, Entity>();
    const factsById = new Map<string, Fact>();
    let currentFrontier = [query.entityId];

    for (let d = 0; d < depth; d++) {
      if (currentFrontier.length === 0 || factsById.size >= factLimit) break;
      const nextFrontier: string[] = [];
      for (const nodeId of currentFrontier) {
        if (factsById.size >= factLimit) break;
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
          if (factsById.size >= factLimit) break;
          factsById.set(fact.id, fact);
          const otherId = fact.from === nodeId ? fact.to : fact.from;
          if (otherId === query.entityId) continue;
          if (entitiesById.has(otherId)) continue;
          if (entitiesById.size >= limit) continue;
          const entity = this.getEntity(otherId);
          if (!entity) continue; // no row: fact kept, no traversal
          if (!asOf && entity.retiredAt) continue;
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

  /** Raw fact rows touching `nodeId`, time-filtered only. */
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
