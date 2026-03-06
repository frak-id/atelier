import { eq } from "drizzle-orm";
import { getDatabase, settings } from "../../infrastructure/database/index.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";

const log = createChildLogger("settings-repository");

export class SettingsRepository {
  get<T>(key: string): T | undefined {
    const row = getDatabase()
      .select()
      .from(settings)
      .where(eq(settings.key, key))
      .get();
    return row ? (row.value as T) : undefined;
  }

  set<T>(key: string, value: T): void {
    const now = new Date().toISOString();
    const existing = getDatabase()
      .select()
      .from(settings)
      .where(eq(settings.key, key))
      .get();

    if (existing) {
      getDatabase()
        .update(settings)
        .set({ value: value as object, updatedAt: now })
        .where(eq(settings.key, key))
        .run();
      log.debug({ key }, "Setting updated");
    } else {
      getDatabase()
        .insert(settings)
        .values({ key, value: value as object, updatedAt: now })
        .run();
      log.debug({ key }, "Setting created");
    }
  }

  delete(key: string): boolean {
    const existing = getDatabase()
      .select()
      .from(settings)
      .where(eq(settings.key, key))
      .get();
    if (!existing) return false;

    getDatabase().delete(settings).where(eq(settings.key, key)).run();
    log.debug({ key }, "Setting deleted");
    return true;
  }
}
