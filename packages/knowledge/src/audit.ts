/**
 * Append-only audit trail. Every governed-memory transition writes one
 * entry here; erasure relies on it staying content-free (see
 * `AuditEntry#detail`) so the log itself is never something that needs to
 * be erased.
 */
import type { KnowledgeDb } from "./db.ts";
import type { Actor, AuditAction, AuditEntry, RecordRef } from "./types.ts";
import { newId, opt, parseJson } from "./util.ts";

/** bun:sqlite `strict:true` bind values; JSON columns are pre-stringified. */
type SqlParams = Record<string, string | number | bigint | boolean | null>;

interface AuditRow {
  id: string;
  at: number;
  actor: string;
  action: string;
  target_kind: string;
  target_id: string;
  detail: string | null;
}

function rowToEntry(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    at: row.at,
    actor: parseJson<Actor>(row.actor, { kind: "system", id: "unknown" }),
    action: row.action as AuditAction,
    target: { kind: row.target_kind as RecordRef["kind"], id: row.target_id },
    detail: opt(
      parseJson<Record<string, unknown> | undefined>(row.detail, undefined),
    ),
  };
}

export interface AuditListFilter {
  target?: RecordRef;
  action?: AuditAction;
  since?: number;
  limit?: number;
}

export class AuditLog {
  constructor(private readonly db: KnowledgeDb) {}

  /** Records one action. Callers must never pass memory/document content. */
  append(
    actor: Actor,
    action: AuditAction,
    target: RecordRef,
    detail?: Record<string, unknown>,
  ): AuditEntry {
    const entry: AuditEntry = {
      id: newId("aud"),
      at: Date.now(),
      actor,
      action,
      target,
      detail,
    };
    this.db
      .query(
        `INSERT INTO audit (id, at, actor, action, target_kind, target_id, detail)
         VALUES ($id, $at, $actor, $action, $targetKind, $targetId, $detail)`,
      )
      .run({
        id: entry.id,
        at: entry.at,
        actor: JSON.stringify(actor),
        action,
        targetKind: target.kind,
        targetId: target.id,
        detail: detail === undefined ? null : JSON.stringify(detail),
      });
    return entry;
  }

  /** Newest first. */
  list(filter: AuditListFilter = {}): AuditEntry[] {
    const clauses: string[] = [];
    const params: SqlParams = {};
    if (filter.target) {
      clauses.push("target_kind = $targetKind AND target_id = $targetId");
      params.targetKind = filter.target.kind;
      params.targetId = filter.target.id;
    }
    if (filter.action) {
      clauses.push("action = $action");
      params.action = filter.action;
    }
    if (filter.since !== undefined) {
      clauses.push("at >= $since");
      params.since = filter.since;
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    params.limit = filter.limit ?? 100;
    const rows = this.db
      .query(
        `SELECT * FROM audit ${where} ORDER BY at DESC, id DESC LIMIT $limit`,
      )
      .all(params) as AuditRow[];
    return rows.map(rowToEntry);
  }
}
