/**
 * The governed-memory lifecycle: propose → approve/reject → active →
 * stale/archived → erased. Agents may only propose; every other
 * transition (except `flag`, anyone's "that's wrong") needs a human actor.
 * See `docs/research/company-agent-prior-art.md` §4.
 */
import { AuditLog } from "../audit.ts";
import type { KnowledgeDb } from "../db.ts";
import { Derivations } from "../derivations.ts";
import { eraseRecords } from "../erasure.ts";
import {
  ForbiddenError,
  InvalidTransitionError,
  NotFoundError,
  ValidationError,
} from "../errors.ts";
import type {
  Actor,
  ErasureHook,
  ErasureReport,
  FactInput,
  GraphStore,
  Memory,
  MemoryFilter,
  MemoryKind,
  MemoryPatch,
  MemoryPolicy,
  MemoryScope,
  MemoryScopeKind,
  MemoryStatus,
  ProposeMemoryInput,
  Provenance,
  RecordRef,
} from "../types.ts";
import { newId, opt, parseJson } from "../util.ts";
import { defaultMemoryPolicy } from "./policy.ts";

/** bun:sqlite `strict:true` bind values; JSON columns are pre-stringified. */
type SqlParams = Record<string, string | number | bigint | boolean | null>;

interface MemoryRow {
  id: string;
  scope_kind: string;
  scope_id: string;
  kind: string;
  content: string;
  tags: string;
  status: string;
  readers: string;
  entity_ids: string;
  facts: string;
  provenance: string;
  created_by: string;
  reviewed_by: string | null;
  review_note: string | null;
  valid_from: number;
  valid_to: number | null;
  supersedes: string | null;
  superseded_by: string | null;
  use_count: number;
  last_used_at: number | null;
  created_at: number;
  updated_at: number;
}

function rowToMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    scope: {
      kind: row.scope_kind as MemoryScopeKind,
      id: row.scope_id,
    },
    kind: row.kind as MemoryKind,
    content: row.content,
    tags: parseJson<string[]>(row.tags, []),
    status: row.status as MemoryStatus,
    readers: parseJson<string[]>(row.readers, []),
    entityIds: parseJson<string[]>(row.entity_ids, []),
    facts: parseJson<FactInput[]>(row.facts, []),
    provenance: parseJson<Provenance[]>(row.provenance, []),
    createdBy: parseJson<Actor>(row.created_by, {
      kind: "system",
      id: "unknown",
    }),
    reviewedBy: row.reviewed_by
      ? parseJson<Actor>(row.reviewed_by, { kind: "system", id: "unknown" })
      : undefined,
    reviewNote: opt(row.review_note),
    validFrom: row.valid_from,
    validTo: opt(row.valid_to),
    supersedes: opt(row.supersedes),
    supersededBy: opt(row.superseded_by),
    useCount: row.use_count,
    lastUsedAt: opt(row.last_used_at),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toParams(memory: Memory): SqlParams {
  return {
    id: memory.id,
    scopeKind: memory.scope.kind,
    scopeId: memory.scope.id,
    kind: memory.kind,
    content: memory.content,
    tags: JSON.stringify(memory.tags),
    status: memory.status,
    readers: JSON.stringify(memory.readers),
    entityIds: JSON.stringify(memory.entityIds),
    facts: JSON.stringify(memory.facts),
    provenance: JSON.stringify(memory.provenance),
    createdBy: JSON.stringify(memory.createdBy),
    reviewedBy: memory.reviewedBy ? JSON.stringify(memory.reviewedBy) : null,
    reviewNote: memory.reviewNote ?? null,
    validFrom: memory.validFrom,
    validTo: memory.validTo ?? null,
    supersedes: memory.supersedes ?? null,
    supersededBy: memory.supersededBy ?? null,
    useCount: memory.useCount,
    lastUsedAt: memory.lastUsedAt ?? null,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  };
}

/** Trim only: internal whitespace is meaningful content. */
function normalizeContent(content: string): string {
  return content.trim();
}

/** Collapsed whitespace + lowercase, for exact-duplicate detection. */
function normalizeForDedup(content: string): string {
  return content.trim().replace(/\s+/g, " ").toLowerCase();
}

function assertContentLength(content: string): void {
  if (content.length < 1 || content.length > 4000) {
    throw new ValidationError(
      "memory content must be between 1 and 4000 characters",
    );
  }
}

function applyPatch(memory: Memory, patch: MemoryPatch): Memory {
  const next: Memory = { ...memory };
  if (patch.content !== undefined) {
    const content = normalizeContent(patch.content);
    assertContentLength(content);
    next.content = content;
  }
  if (patch.tags !== undefined) next.tags = patch.tags;
  if (patch.readers !== undefined) next.readers = patch.readers;
  if (patch.entityIds !== undefined) next.entityIds = patch.entityIds;
  if (patch.facts !== undefined) next.facts = patch.facts;
  if (patch.scope !== undefined) {
    if (patch.scope.kind !== "org" && !patch.scope.id) {
      throw new ValidationError(
        `scope.id is required for scope kind "${patch.scope.kind}"`,
      );
    }
    next.scope = patch.scope;
  }
  if (patch.kind !== undefined) next.kind = patch.kind;
  if (patch.validFrom !== undefined) next.validFrom = patch.validFrom;
  if (patch.validTo !== undefined) {
    next.validTo = patch.validTo === null ? undefined : patch.validTo;
  }
  return next;
}

const ARCHIVABLE_STATUSES: MemoryStatus[] = ["active", "stale", "proposed"];

export interface MemoryServiceOptions {
  policy?: MemoryPolicy;
  graph?: GraphStore;
  clock?: () => number;
  hooks?: ErasureHook[];
}

export class MemoryService {
  private readonly policy: MemoryPolicy;
  private readonly graph: GraphStore | undefined;
  private readonly clock: () => number;
  private readonly hooks: ErasureHook[];
  private readonly audit: AuditLog;
  private readonly derivations: Derivations;

  constructor(
    private readonly db: KnowledgeDb,
    opts?: MemoryServiceOptions,
  ) {
    this.policy = opts?.policy ?? defaultMemoryPolicy;
    this.graph = opts?.graph;
    this.clock = opts?.clock ?? (() => Date.now());
    this.hooks = opts?.hooks ?? [];
    this.audit = new AuditLog(db);
    this.derivations = new Derivations(db);
  }

  // ── lifecycle ─────────────────────────────────────────────────────────

  /**
   * Any actor may propose. Exact duplicates (same scope, normalized
   * content) among proposed/active memories return the existing row
   * instead of creating a new one. Policy decides auto-activation.
   */
  propose(input: ProposeMemoryInput, actor: Actor): Memory {
    const content = normalizeContent(input.content);
    assertContentLength(content);
    if (input.scope.kind !== "org" && !input.scope.id) {
      throw new ValidationError(
        `scope.id is required for scope kind "${input.scope.kind}"`,
      );
    }

    if (input.supersedes) {
      const target = this.getRow(input.supersedes);
      if (!target) throw new NotFoundError("memory", input.supersedes);
      if (target.status !== "active" && target.status !== "stale") {
        throw new ValidationError(
          `memory ${input.supersedes} must be active or stale to be ` +
            "superseded",
        );
      }
    }

    const dup = this.findDuplicate(input.scope, content);
    if (dup) return dup;

    const now = this.clock();
    const proposeInput = { ...input, content };
    const autoActivate = this.policy.autoActivate(proposeInput, actor);
    const status: MemoryStatus = autoActivate ? "active" : "proposed";
    const readers = input.readers ?? this.policy.defaultReaders(input.scope);

    const memory: Memory = {
      id: newId("mem"),
      scope: input.scope,
      kind: input.kind,
      content,
      tags: input.tags ?? [],
      status,
      readers,
      entityIds: input.entityIds ?? [],
      facts: input.facts ?? [],
      provenance: input.provenance ?? [],
      createdBy: actor,
      validFrom: input.validFrom ?? now,
      validTo: input.validTo,
      supersedes: input.supersedes,
      useCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    this.db.transaction(() => {
      this.insert(memory);
      this.audit.append(actor, "memory.propose", {
        kind: "memory",
        id: memory.id,
      });
      if (autoActivate) {
        this.audit.append(
          { kind: "system", id: "system" },
          "memory.approve",
          { kind: "memory", id: memory.id },
          { auto: true },
        );
        this.syncGraphActive(memory);
      }
    })();

    return memory;
  }

  /** Human only. Moves `proposed`/`stale` to `active`. */
  approve(
    id: string,
    actor: Actor,
    opts?: { note?: string; patch?: MemoryPatch },
  ): Memory {
    this.requireHuman(actor);
    const row = this.getRowOrThrow(id);
    if (row.status !== "proposed" && row.status !== "stale") {
      throw new InvalidTransitionError(id, row.status, "approve");
    }
    const now = this.clock();

    return this.db.transaction(() => {
      let memory = rowToMemory(row);
      if (opts?.patch) memory = applyPatch(memory, opts.patch);
      memory.status = "active";
      memory.reviewedBy = actor;
      memory.reviewNote = opts?.note;
      memory.updatedAt = now;
      this.update(memory);
      this.audit.append(
        actor,
        "memory.approve",
        { kind: "memory", id },
        opts?.note ? { note: opts.note } : undefined,
      );
      this.syncGraphActive(memory);

      if (memory.supersedes) {
        const prevRow = this.getRow(memory.supersedes);
        if (prevRow) {
          const prev = rowToMemory(prevRow);
          prev.status = "archived";
          prev.supersededBy = memory.id;
          if (prev.validTo === undefined) prev.validTo = now;
          prev.updatedAt = now;
          this.update(prev);
          this.syncGraphInactive(prev);
          this.audit.append(
            actor,
            "memory.supersede",
            { kind: "memory", id: prev.id },
            { supersededBy: memory.id },
          );
        }
      }

      return memory;
    })();
  }

  /** Human only. `proposed` → `rejected`. */
  reject(id: string, actor: Actor, note?: string): Memory {
    this.requireHuman(actor);
    const row = this.getRowOrThrow(id);
    if (row.status !== "proposed") {
      throw new InvalidTransitionError(id, row.status, "reject");
    }
    const memory = rowToMemory(row);
    memory.status = "rejected";
    memory.reviewedBy = actor;
    memory.reviewNote = note;
    memory.updatedAt = this.clock();
    this.db.transaction(() => {
      this.update(memory);
      this.audit.append(
        actor,
        "memory.reject",
        { kind: "memory", id },
        note ? { note } : undefined,
      );
    })();
    return memory;
  }

  /** Human only, not on `rejected`. */
  edit(id: string, patch: MemoryPatch, actor: Actor): Memory {
    this.requireHuman(actor);
    const row = this.getRowOrThrow(id);
    if (row.status === "rejected") {
      throw new InvalidTransitionError(id, row.status, "edit");
    }
    const wasActive = row.status === "active";
    const memory = applyPatch(rowToMemory(row), patch);
    memory.updatedAt = this.clock();
    this.db.transaction(() => {
      this.update(memory);
      this.audit.append(actor, "memory.edit", { kind: "memory", id });
      if (wasActive) this.syncGraphActive(memory);
    })();
    return memory;
  }

  /** Any actor: "that's wrong". `active` → `stale`. */
  flag(id: string, actor: Actor, reason: string): Memory {
    const row = this.getRowOrThrow(id);
    if (row.status !== "active") {
      throw new InvalidTransitionError(id, row.status, "flag");
    }
    const memory = rowToMemory(row);
    memory.status = "stale";
    memory.updatedAt = this.clock();
    this.db.transaction(() => {
      this.update(memory);
      this.audit.append(
        actor,
        "memory.flag",
        { kind: "memory", id },
        {
          reason,
        },
      );
      this.syncGraphInactive(memory);
    })();
    return memory;
  }

  /** Human only. `stale`/`archived` → `active`. */
  restore(id: string, actor: Actor): Memory {
    this.requireHuman(actor);
    const row = this.getRowOrThrow(id);
    if (row.status !== "stale" && row.status !== "archived") {
      throw new InvalidTransitionError(id, row.status, "restore");
    }
    const memory = rowToMemory(row);
    memory.status = "active";
    memory.updatedAt = this.clock();
    this.db.transaction(() => {
      this.update(memory);
      this.audit.append(actor, "memory.restore", { kind: "memory", id });
      this.syncGraphActive(memory);
    })();
    return memory;
  }

  /** Human only. Retires one memory ("context switch"). */
  archive(id: string, actor: Actor, reason?: string): Memory {
    this.requireHuman(actor);
    const row = this.getRowOrThrow(id);
    if (!ARCHIVABLE_STATUSES.includes(row.status as MemoryStatus)) {
      throw new InvalidTransitionError(id, row.status, "archive");
    }
    const wasActive = row.status === "active";
    const memory = rowToMemory(row);
    memory.status = "archived";
    memory.updatedAt = this.clock();
    this.db.transaction(() => {
      this.update(memory);
      this.audit.append(
        actor,
        "memory.archive",
        { kind: "memory", id },
        reason ? { reason } : undefined,
      );
      if (wasActive) this.syncGraphInactive(memory);
    })();
    return memory;
  }

  /** Human only. Bulk "context switch"; returns the number archived. */
  archiveWhere(filter: MemoryFilter, actor: Actor, reason?: string): number {
    this.requireHuman(actor);
    const rows = this.queryRows({ ...filter, limit: filter.limit ?? 500 });
    const now = this.clock();
    let count = 0;
    this.db.transaction(() => {
      for (const row of rows) {
        if (!ARCHIVABLE_STATUSES.includes(row.status as MemoryStatus)) {
          continue;
        }
        const wasActive = row.status === "active";
        const memory = rowToMemory(row);
        memory.status = "archived";
        memory.updatedAt = now;
        this.update(memory);
        this.audit.append(
          actor,
          "memory.archive",
          { kind: "memory", id: memory.id },
          reason ? { reason } : undefined,
        );
        if (wasActive) this.syncGraphInactive(memory);
        count++;
      }
    })();
    return count;
  }

  /**
   * Human only. Hard-deletes the memories and everything derived from
   * them (see `erasure.ts`). Dangling supersede pointers on other rows
   * are cleared; one content-free `memory.erase` audit entry per memory.
   */
  async erase(
    ids: string[],
    actor: Actor,
    reason?: string,
  ): Promise<ErasureReport> {
    this.requireHuman(actor);
    if (ids.length === 0) {
      return { roots: [], erased: [], external: [] };
    }
    const rows = ids.map((id) => this.getRowOrThrow(id));
    const roots: RecordRef[] = rows.map((row) => ({
      kind: "memory",
      id: row.id,
    }));

    // Cascade counts must be gathered before erasure removes the
    // derivation rows and facts they describe.
    const cascade = new Map<string, Record<string, number>>();
    for (const row of rows) {
      const descendants = this.derivations.descendants({
        kind: "memory",
        id: row.id,
      });
      const factRow = this.db
        .query("SELECT COUNT(*) as n FROM facts WHERE source_key = $key")
        .get({ key: `memory:${row.id}` }) as { n: number };
      const byKind: Record<string, number> = {};
      for (const d of descendants) byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
      if (factRow.n > 0) byKind.fact = (byKind.fact ?? 0) + factRow.n;
      cascade.set(row.id, byKind);
    }

    const report = await eraseRecords(this.db, roots, {
      hooks: this.hooks,
    });

    this.db.transaction(() => {
      for (const row of rows) {
        this.db
          .query("UPDATE memories SET supersedes = NULL WHERE supersedes = $id")
          .run({ id: row.id });
        this.db
          .query(
            `UPDATE memories SET superseded_by = NULL
             WHERE superseded_by = $id`,
          )
          .run({ id: row.id });
        this.audit.append(
          actor,
          "memory.erase",
          { kind: "memory", id: row.id },
          {
            ...(reason ? { reason } : {}),
            cascade: cascade.get(row.id) ?? {},
          },
        );
      }
    })();

    return report;
  }

  /** Bumps `use_count`/`last_used_at`; silently skips missing ids. */
  recordUse(ids: string[], actor: Actor): void {
    const now = this.clock();
    this.db.transaction(() => {
      for (const id of ids) {
        if (!this.getRow(id)) continue;
        this.db
          .query(
            `UPDATE memories
             SET use_count = use_count + 1, last_used_at = $now
             WHERE id = $id`,
          )
          .run({ id, now });
        this.audit.append(actor, "memory.use", { kind: "memory", id });
      }
    })();
  }

  // ── reads ────────────────────────────────────────────────────────────

  get(id: string): Memory | undefined {
    const row = this.getRow(id);
    return row ? rowToMemory(row) : undefined;
  }

  list(filter: MemoryFilter = {}): Memory[] {
    return this.queryRows(filter).map(rowToMemory);
  }

  /** `proposed` (oldest first) then `stale` (oldest first). */
  reviewQueue(limit = 50): Memory[] {
    const proposed = this.db
      .query(
        `SELECT * FROM memories WHERE status = 'proposed'
         ORDER BY created_at ASC LIMIT $limit`,
      )
      .all({ limit }) as MemoryRow[];
    const remaining = Math.max(limit - proposed.length, 0);
    const stale =
      remaining > 0
        ? (this.db
            .query(
              `SELECT * FROM memories WHERE status = 'stale'
               ORDER BY created_at ASC LIMIT $limit`,
            )
            .all({ limit: remaining }) as MemoryRow[])
        : [];
    return [...proposed, ...stale].map(rowToMemory);
  }

  // ── internals ────────────────────────────────────────────────────────

  private requireHuman(actor: Actor): void {
    if (actor.kind !== "human") {
      throw new ForbiddenError(
        `only a human may perform this action (actor: ${actor.kind}:` +
          `${actor.id})`,
      );
    }
  }

  private findDuplicate(
    scope: MemoryScope,
    content: string,
  ): Memory | undefined {
    const norm = normalizeForDedup(content);
    const rows = this.db
      .query(
        `SELECT * FROM memories
         WHERE scope_kind = $scopeKind AND scope_id = $scopeId
           AND status IN ('proposed', 'active')`,
      )
      .all({ scopeKind: scope.kind, scopeId: scope.id }) as MemoryRow[];
    for (const row of rows) {
      if (normalizeForDedup(row.content) === norm) return rowToMemory(row);
    }
    return undefined;
  }

  private queryRows(filter: MemoryFilter): MemoryRow[] {
    const clauses: string[] = [];
    const params: SqlParams = {};

    if (filter.status && filter.status.length > 0) {
      const names: string[] = [];
      filter.status.forEach((status, i) => {
        names.push(`$status${i}`);
        params[`status${i}`] = status;
      });
      clauses.push(`status IN (${names.join(", ")})`);
    }
    if (filter.scope?.kind !== undefined) {
      clauses.push("scope_kind = $scopeKind");
      params.scopeKind = filter.scope.kind;
    }
    if (filter.scope?.id !== undefined) {
      clauses.push("scope_id = $scopeId");
      params.scopeId = filter.scope.id;
    }
    if (filter.kind && filter.kind.length > 0) {
      const names: string[] = [];
      filter.kind.forEach((kind, i) => {
        names.push(`$kind${i}`);
        params[`kind${i}`] = kind;
      });
      clauses.push(`kind IN (${names.join(", ")})`);
    }
    if (filter.tags && filter.tags.length > 0) {
      filter.tags.forEach((tag, i) => {
        clauses.push(
          `EXISTS (SELECT 1 FROM json_each(tags) WHERE value = $tag${i})`,
        );
        params[`tag${i}`] = tag;
      });
    }
    if (filter.entityId !== undefined) {
      clauses.push(
        "EXISTS (SELECT 1 FROM json_each(entity_ids) WHERE value = $entityId)",
      );
      params.entityId = filter.entityId;
    }
    if (filter.createdBefore !== undefined) {
      clauses.push("created_at < $createdBefore");
      params.createdBefore = filter.createdBefore;
    }
    if (filter.createdAfter !== undefined) {
      clauses.push("created_at > $createdAfter");
      params.createdAfter = filter.createdAfter;
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    params.limit = Math.min(filter.limit ?? 50, 500);
    params.offset = filter.offset ?? 0;

    return this.db
      .query(
        `SELECT * FROM memories ${where}
         ORDER BY updated_at DESC LIMIT $limit OFFSET $offset`,
      )
      .all(params) as MemoryRow[];
  }

  private syncGraphActive(memory: Memory): void {
    if (!this.graph) return;
    this.graph.assertFacts(
      { key: `memory:${memory.id}`, revision: String(memory.updatedAt) },
      memory.facts.map((fact) => ({
        ...fact,
        readers: fact.readers ?? memory.readers,
      })),
    );
  }

  private syncGraphInactive(memory: Memory): void {
    this.graph?.retractSource(`memory:${memory.id}`);
  }

  private insert(memory: Memory): void {
    this.db
      .query(
        `INSERT INTO memories (
          id, scope_kind, scope_id, kind, content, tags, status, readers,
          entity_ids, facts, provenance, created_by, reviewed_by,
          review_note, valid_from, valid_to, supersedes, superseded_by,
          use_count, last_used_at, created_at, updated_at
        ) VALUES (
          $id, $scopeKind, $scopeId, $kind, $content, $tags, $status,
          $readers, $entityIds, $facts, $provenance, $createdBy,
          $reviewedBy, $reviewNote, $validFrom, $validTo, $supersedes,
          $supersededBy, $useCount, $lastUsedAt, $createdAt, $updatedAt
        )`,
      )
      .run(toParams(memory));
  }

  private update(memory: Memory): void {
    this.db
      .query(
        `UPDATE memories SET
          scope_kind = $scopeKind, scope_id = $scopeId, kind = $kind,
          content = $content, tags = $tags, status = $status,
          readers = $readers, entity_ids = $entityIds, facts = $facts,
          provenance = $provenance, reviewed_by = $reviewedBy,
          review_note = $reviewNote, valid_from = $validFrom,
          valid_to = $validTo, supersedes = $supersedes,
          superseded_by = $supersededBy, use_count = $useCount,
          last_used_at = $lastUsedAt, updated_at = $updatedAt
        WHERE id = $id`,
      )
      .run(toParams(memory));
  }

  private getRow(id: string): MemoryRow | undefined {
    return this.db.query("SELECT * FROM memories WHERE id = $id").get({
      id,
    }) as MemoryRow | undefined;
  }

  private getRowOrThrow(id: string): MemoryRow {
    const row = this.getRow(id);
    if (!row) throw new NotFoundError("memory", id);
    return row;
  }
}
