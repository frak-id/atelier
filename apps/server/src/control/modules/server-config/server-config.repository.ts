import { eq } from "drizzle-orm";
import { getDatabase } from "../../db/client.ts";
import { serverConfig } from "../../db/schema.ts";
import type { ConfigValue } from "./registry.ts";

interface SettingRow {
  key: string;
  value: ConfigValue;
  updatedAt: string;
}

/** Dumb key/value access over the `server_config` table. Knows nothing about which
 * keys exist or what they mean — that's the registry's job. */
export class ServerConfigRepository {
  get(key: string): SettingRow | undefined {
    return getDatabase()
      .select()
      .from(serverConfig)
      .where(eq(serverConfig.key, key))
      .get() as SettingRow | undefined;
  }

  list(): SettingRow[] {
    return getDatabase().select().from(serverConfig).all() as SettingRow[];
  }

  set(key: string, value: ConfigValue): void {
    const db = getDatabase();
    const updatedAt = new Date().toISOString();
    db.insert(serverConfig)
      .values({ key, value, updatedAt })
      .onConflictDoUpdate({
        target: serverConfig.key,
        set: { value, updatedAt },
      })
      .run();
  }
}
