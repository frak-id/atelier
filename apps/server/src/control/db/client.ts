import { Database } from "bun:sqlite";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createChildLogger } from "../../shared/lib/logger.ts";
import { appPaths, ensureAppDirs } from "../../shared/lib/paths.ts";

const log = createChildLogger("control-db");

let db: BunSQLiteDatabase | null = null;

export async function initDatabase(): Promise<BunSQLiteDatabase> {
  if (db) return db;

  await ensureAppDirs();

  const sqlite = new Database(appPaths.database, { create: true });
  sqlite.run("PRAGMA journal_mode = WAL");

  db = drizzle(sqlite);

  const migrationsFolder =
    process.env.MIGRATIONS_DIR ?? `${process.cwd()}/drizzle`;
  migrate(db, { migrationsFolder });

  log.info(
    { path: appPaths.database, migrationsFolder },
    "Control database initialized",
  );
  return db;
}

export function getDatabase(): BunSQLiteDatabase {
  if (!db) {
    throw new Error("Database not initialized. Call initDatabase() first.");
  }
  return db;
}
