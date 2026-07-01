import { and, eq } from "drizzle-orm";
import { getDatabase } from "../../db/client.ts";
import { apiKeys } from "../../db/schema.ts";
import type { ApiKey } from "../../types.ts";

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
    return getDatabase()
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.userId, userId))
      .all()
      .map(rowToApiKey);
  }

  getByKeyHash(keyHash: string): ApiKey | undefined {
    const row = getDatabase()
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, keyHash))
      .get();
    return row ? rowToApiKey(row) : undefined;
  }

  create(apiKey: ApiKey & { keyHash: string }): ApiKey {
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
    getDatabase().insert(apiKeys).values(row).run();
    return rowToApiKey(row as typeof apiKeys.$inferSelect);
  }

  delete(id: string, userId: string): boolean {
    getDatabase()
      .delete(apiKeys)
      .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId)))
      .run();
    return true;
  }

  touchLastUsed(id: string): void {
    getDatabase()
      .update(apiKeys)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(eq(apiKeys.id, id))
      .run();
  }
}
