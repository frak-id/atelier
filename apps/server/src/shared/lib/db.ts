import { Database } from "bun:sqlite";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createChildLogger } from "./logger.ts";
import { appPaths, ensureAppDirs } from "./paths.ts";

/**
 * The single sqlite connection shared by `control/` and `runtime/`. Lives
 * here (not in `control/db/client.ts`) so `runtime/` can persist without
 * importing `control/` — enforced by `scripts/check-boundaries.ts`. One file,
 * one connection; `control/` and `runtime/` each own disjoint tables in their
 * own schema module (no FK between them, atelier-v2 §3.1).
 */
const log = createChildLogger("db");

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
    "Database initialized",
  );
  return db;
}

export function getDatabase(): BunSQLiteDatabase {
  if (!db) {
    throw new Error("Database not initialized. Call initDatabase() first.");
  }
  return db;
}
