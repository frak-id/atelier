import { eq } from "drizzle-orm";
import {
  getDatabase,
  sharedAuth,
} from "../../infrastructure/database/index.ts";

export interface SharedAuthRecord {
  id: string;
  provider: string;
  content: string;
  updatedAt: string;
  updatedBy: string | null;
}

function rowToSharedAuth(
  row: typeof sharedAuth.$inferSelect,
): SharedAuthRecord {
  return {
    id: row.id,
    provider: row.provider,
    content: row.content,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}

export class SharedAuthRepository {
  getByProvider(provider: string): SharedAuthRecord | undefined {
    const db = getDatabase();
    const row = db
      .select()
      .from(sharedAuth)
      .where(eq(sharedAuth.provider, provider))
      .get();
    return row ? rowToSharedAuth(row) : undefined;
  }

  upsert(
    provider: string,
    content: string,
    updatedBy?: string,
  ): SharedAuthRecord {
    const db = getDatabase();
    const now = new Date().toISOString();
    const existing = this.getByProvider(provider);

    if (existing) {
      db.update(sharedAuth)
        .set({
          content,
          updatedAt: now,
          updatedBy: updatedBy ?? null,
        })
        .where(eq(sharedAuth.provider, provider))
        .run();

      return {
        ...existing,
        content,
        updatedAt: now,
        updatedBy: updatedBy ?? null,
      };
    }

    const id = `auth-${provider}-${Date.now()}`;
    const row: typeof sharedAuth.$inferInsert = {
      id,
      provider,
      content,
      updatedAt: now,
      updatedBy: updatedBy ?? null,
    };

    db.insert(sharedAuth).values(row).run();

    return rowToSharedAuth(row as typeof sharedAuth.$inferSelect);
  }
}
