import { and, eq } from "drizzle-orm";
import { getDatabase } from "../../db/client.ts";
import { integrationConnections } from "../../db/schema.ts";

export type ConnectionRow = typeof integrationConnections.$inferSelect;

export class IntegrationConnectionRepository {
  get(userId: string, integrationId: string): ConnectionRow | undefined {
    return getDatabase()
      .select()
      .from(integrationConnections)
      .where(
        and(
          eq(integrationConnections.userId, userId),
          eq(integrationConnections.integrationId, integrationId),
        ),
      )
      .get();
  }

  listByUser(userId: string): ConnectionRow[] {
    return getDatabase()
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.userId, userId))
      .all();
  }

  upsert(row: ConnectionRow): void {
    const { id: _id, createdAt: _createdAt, ...update } = row;
    getDatabase()
      .insert(integrationConnections)
      .values(row)
      .onConflictDoUpdate({
        target: [
          integrationConnections.userId,
          integrationConnections.integrationId,
        ],
        set: update,
      })
      .run();
  }

  delete(userId: string, integrationId: string): void {
    getDatabase()
      .delete(integrationConnections)
      .where(
        and(
          eq(integrationConnections.userId, userId),
          eq(integrationConnections.integrationId, integrationId),
        ),
      )
      .run();
  }
}
