import { and, eq, isNotNull, lt } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getDatabase, sshKeys } from "../../infrastructure/database/index.ts";
import type { SshKey, SshKeyType } from "../../schemas/index.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";

const log = createChildLogger("ssh-key-repository");

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
    const db = getDatabase();
    return db
      .select()
      .from(sshKeys)
      .where(eq(sshKeys.userId, userId))
      .all()
      .map(rowToSshKey);
  }

  listAll(): SshKey[] {
    const db = getDatabase();
    return db.select().from(sshKeys).all().map(rowToSshKey);
  }

  getById(id: string): SshKey | undefined {
    const db = getDatabase();
    const row = db.select().from(sshKeys).where(eq(sshKeys.id, id)).get();
    return row ? rowToSshKey(row) : undefined;
  }

  create(options: CreateOptions): SshKey {
    const db = getDatabase();
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
    db.insert(sshKeys).values(row).run();
    log.info({ id: row.id, userId: options.userId }, "SSH key created");
    return rowToSshKey(row as typeof sshKeys.$inferSelect);
  }

  delete(id: string): boolean {
    const db = getDatabase();
    const existing = this.getById(id);
    if (!existing) return false;
    db.delete(sshKeys).where(eq(sshKeys.id, id)).run();
    log.info({ id }, "SSH key deleted");
    return true;
  }

  deleteExpired(): number {
    const db = getDatabase();
    const now = new Date().toISOString();
    const expiredCondition = and(
      isNotNull(sshKeys.expiresAt),
      lt(sshKeys.expiresAt, now),
    );
    const expiredKeys = db.select().from(sshKeys).where(expiredCondition).all();
    if (expiredKeys.length > 0) {
      db.delete(sshKeys).where(expiredCondition).run();
      log.info({ count: expiredKeys.length }, "Expired SSH keys cleaned up");
    }
    return expiredKeys.length;
  }
}
