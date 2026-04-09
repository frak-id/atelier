import { and, eq } from "drizzle-orm";
import { apiKeys, getDatabase } from "../../infrastructure/database/index.ts";
import type { ApiKey } from "../../schemas/index.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";

const log = createChildLogger("api-key-repository");

function rowToApiKey(row: typeof apiKeys.$inferSelect): ApiKey {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    keyPrefix: row.keyPrefix,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt ?? null,
    expiresAt: row.expiresAt ?? null,
  };
}

export class ApiKeyRepository {
  getByUserId(userId: string): ApiKey[] {
    const db = getDatabase();
    return db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.userId, userId))
      .all()
      .map(rowToApiKey);
  }

  getByKeyHash(keyHash: string): ApiKey | undefined {
    const db = getDatabase();
    const row = db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, keyHash))
      .get();
    return row ? rowToApiKey(row) : undefined;
  }

  create(apiKey: ApiKey & { keyHash: string }): ApiKey {
    const db = getDatabase();
    const row: typeof apiKeys.$inferInsert = {
      id: apiKey.id,
      userId: apiKey.userId,
      name: apiKey.name,
      keyPrefix: apiKey.keyPrefix,
      keyHash: apiKey.keyHash,
      createdAt: apiKey.createdAt,
      lastUsedAt: apiKey.lastUsedAt ?? null,
      expiresAt: apiKey.expiresAt ?? null,
    };
    db.insert(apiKeys).values(row).run();
    log.info({ id: apiKey.id, userId: apiKey.userId }, "API key created");
    return rowToApiKey(row as typeof apiKeys.$inferSelect);
  }

  delete(id: string, userId: string): boolean {
    const db = getDatabase();
    db.delete(apiKeys)
      .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId)))
      .run();
    log.info({ id }, "API key deleted");
    return true;
  }

  touchLastUsed(id: string): void {
    const db = getDatabase();
    db.update(apiKeys)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(eq(apiKeys.id, id))
      .run();
  }
}
