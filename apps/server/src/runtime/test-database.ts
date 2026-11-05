/**
 * Test helper: point the shared database at a fresh in-memory SQLite with
 * the real migrations applied, so runtime tests exercise the `Drizzle*`
 * stores production uses. Call from `beforeEach`; every call starts empty.
 */
import { Database } from "bun:sqlite";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { setDatabase } from "../shared/lib/db.ts";

const MIGRATIONS_FOLDER = fileURLToPath(
  new URL("../../drizzle", import.meta.url),
);

export function useTestDatabase(): void {
  const db = drizzle(new Database(":memory:"));
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  setDatabase(db);
}
