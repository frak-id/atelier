import { and, eq, isNotNull, lt } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getDatabase } from "../../db/client.ts";
import { sshKeys } from "../../db/schema.ts";
import type { SshKey, SshKeyType } from "../../types.ts";

function rowToSshKey(row: typeof sshKeys.$inferSelect): SshKey {
  return {
    id: row.id,
    userId: row.userId,
    username: row.username,
    publicKey: row.publicKey,
    fingerprint: row.fingerprint,
    name: row.name,
    type: row.type,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

interface CreateOptions {
  userId: string;
  username: string;
  publicKey: string;
  fingerprint: string;
  name: string;
  type: SshKeyType;
  expiresAt?: string;
}

export class SshKeyRepository {
  listByUserId(userId: string): SshKey[] {
    return getDatabase()
      .select()
      .from(sshKeys)
      .where(eq(sshKeys.userId, userId))
      .all()
      .map(rowToSshKey);
  }

  listAll(): SshKey[] {
    return getDatabase().select().from(sshKeys).all().map(rowToSshKey);
  }

  getById(id: string): SshKey | undefined {
    const row = getDatabase()
      .select()
      .from(sshKeys)
      .where(eq(sshKeys.id, id))
      .get();
    return row ? rowToSshKey(row) : undefined;
  }

  create(options: CreateOptions): SshKey {
    const now = new Date().toISOString();
    const row: typeof sshKeys.$inferInsert = {
      id: nanoid(12),
      userId: options.userId,
      username: options.username,
      publicKey: options.publicKey,
      fingerprint: options.fingerprint,
      name: options.name,
      type: options.type,
      expiresAt: options.expiresAt ?? null,
      createdAt: now,
      updatedAt: now,
    };
    getDatabase().insert(sshKeys).values(row).run();
    return rowToSshKey(row as typeof sshKeys.$inferSelect);
  }

  delete(id: string): boolean {
    const existing = this.getById(id);
    if (!existing) return false;
    getDatabase().delete(sshKeys).where(eq(sshKeys.id, id)).run();
    return true;
  }

  deleteExpired(): number {
    const now = new Date().toISOString();
    const expiredCondition = and(
      isNotNull(sshKeys.expiresAt),
      lt(sshKeys.expiresAt, now),
    );
    const db = getDatabase();
    const expiredKeys = db.select().from(sshKeys).where(expiredCondition).all();
    if (expiredKeys.length > 0) {
      db.delete(sshKeys).where(expiredCondition).run();
    }
    return expiredKeys.length;
  }
}
