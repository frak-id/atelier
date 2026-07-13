import { eq } from "drizzle-orm";
import { getDatabase } from "../../db/client.ts";
import { settings } from "../../db/schema.ts";
import type { ConfigValue } from "./registry.ts";

interface SettingRow {
  key: string;
  value: ConfigValue;
  updatedAt: string;
}

/** Dumb key/value access over the `settings` table. Knows nothing about which
 * keys exist or what they mean — that's the registry's job. */
export class ServerConfigRepository {
  get(key: string): SettingRow | undefined {
    return getDatabase()
      .select()
      .from(settings)
      .where(eq(settings.key, key))
      .get() as SettingRow | undefined;
  }

  list(): SettingRow[] {
    return getDatabase().select().from(settings).all() as SettingRow[];
  }

  set(key: string, value: ConfigValue): void {
    const db = getDatabase();
    const updatedAt = new Date().toISOString();
    db.insert(settings)
      .values({ key, value, updatedAt })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value, updatedAt },
      })
      .run();
  }
}
