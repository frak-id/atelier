import { and, eq, isNull } from "drizzle-orm";
import { getDatabase } from "../../db/client.ts";
import { secrets } from "../../db/schema.ts";

interface SecretRow {
  id: string;
  orgId: string | null;
  name: string;
  encryptedValue: string;
  createdAt: string;
  updatedAt: string;
}

export class SecretRepository {
  list(orgId?: string): SecretRow[] {
    return getDatabase()
      .select()
      .from(secrets)
      .where(orgId ? eq(secrets.orgId, orgId) : isNull(secrets.orgId))
      .all();
  }

  getByName(orgId: string | undefined, name: string): SecretRow | undefined {
    return getDatabase()
      .select()
      .from(secrets)
      .where(
        and(
          orgId ? eq(secrets.orgId, orgId) : isNull(secrets.orgId),
          eq(secrets.name, name),
        ),
      )
      .get();
  }

  upsert(row: SecretRow): void {
    const db = getDatabase();
    const existing = this.getByName(row.orgId ?? undefined, row.name);
    if (existing) {
      db.update(secrets)
        .set({ encryptedValue: row.encryptedValue, updatedAt: row.updatedAt })
        .where(eq(secrets.id, existing.id))
        .run();
      return;
    }
    db.insert(secrets).values(row).run();
  }

  delete(id: string): boolean {
    const db = getDatabase();
    const existing = db.select().from(secrets).where(eq(secrets.id, id)).get();
    if (!existing) return false;
    db.delete(secrets).where(eq(secrets.id, id)).run();
    return true;
  }
}
