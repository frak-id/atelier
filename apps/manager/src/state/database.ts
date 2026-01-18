import { Database } from "bun:sqlite";
import { eq, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import {
  configFiles,
  gitSources,
  type SandboxStatus,
  sandboxes,
  workspaces,
} from "../db/schema.ts";
import { createChildLogger } from "../lib/logger.ts";
import { appPaths, ensureAppDirs } from "../lib/paths.ts";
import type {
  ConfigFile,
  GitSource,
  Sandbox,
  Workspace,
} from "../schemas/index.ts";

const log = createChildLogger("database");

let db: BunSQLiteDatabase | null = null;
let sqlite: Database | null = null;

export async function initDatabase(): Promise<BunSQLiteDatabase> {
  if (db) return db;

  await ensureAppDirs();

  sqlite = new Database(appPaths.database, { create: true });
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
  if (!db)
    throw new Error("Database not initialized. Call initDatabase() first.");
  return db;
}

export const GitSourceRepository = {
  getAll(): GitSource[] {
    return getDatabase()
      .select()
      .from(gitSources)
      .all()
      .map((row) => ({
        id: row.id,
        type: row.type,
        name: row.name,
        config: row.config,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }));
  },

  getById(id: string): GitSource | undefined {
    const row = getDatabase()
      .select()
      .from(gitSources)
      .where(eq(gitSources.id, id))
      .get();
    if (!row) return undefined;
    return {
      id: row.id,
      type: row.type,
      name: row.name,
      config: row.config,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  },

  getByType(type: string): GitSource[] {
    return getDatabase()
      .select()
      .from(gitSources)
      .where(eq(gitSources.type, type as "github" | "gitlab" | "custom"))
      .all()
      .map((row) => ({
        id: row.id,
        type: row.type,
        name: row.name,
        config: row.config,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }));
  },

  create(source: GitSource): GitSource {
    getDatabase()
      .insert(gitSources)
      .values({
        id: source.id,
        type: source.type,
        name: source.name,
        config: source.config,
        createdAt: source.createdAt,
        updatedAt: source.updatedAt,
      })
      .run();
    log.info({ sourceId: source.id, type: source.type }, "Git source created");
    return source;
  },

  update(id: string, updates: Partial<GitSource>): GitSource {
    const existing = this.getById(id);
    if (!existing) throw new Error(`Git source '${id}' not found`);

    const updated: GitSource = {
      ...existing,
      ...updates,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };

    getDatabase()
      .update(gitSources)
      .set({
        name: updated.name,
        config: updated.config,
        updatedAt: updated.updatedAt,
      })
      .where(eq(gitSources.id, id))
      .run();

    log.debug({ sourceId: id }, "Git source updated");
    return updated;
  },

  delete(id: string): boolean {
    const existing = this.getById(id);
    if (!existing) return false;

    getDatabase().delete(gitSources).where(eq(gitSources.id, id)).run();
    log.info({ sourceId: id }, "Git source deleted");
    return true;
  },
};

export const WorkspaceRepository = {
  getAll(): Workspace[] {
    return getDatabase()
      .select()
      .from(workspaces)
      .all()
      .map((row) => ({
        id: row.id,
        name: row.name,
        config: row.config,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }));
  },

  getById(id: string): Workspace | undefined {
    const row = getDatabase()
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, id))
      .get();
    if (!row) return undefined;
    return {
      id: row.id,
      name: row.name,
      config: row.config,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  },

  create(workspace: Workspace): Workspace {
    getDatabase()
      .insert(workspaces)
      .values({
        id: workspace.id,
        name: workspace.name,
        config: workspace.config,
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
      })
      .run();
    log.info(
      { workspaceId: workspace.id, name: workspace.name },
      "Workspace created",
    );
    return workspace;
  },

  update(id: string, updates: Partial<Workspace>): Workspace {
    const existing = this.getById(id);
    if (!existing) throw new Error(`Workspace '${id}' not found`);

    const updated: Workspace = {
      ...existing,
      ...updates,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };

    getDatabase()
      .update(workspaces)
      .set({
        name: updated.name,
        config: updated.config,
        updatedAt: updated.updatedAt,
      })
      .where(eq(workspaces.id, id))
      .run();

    log.debug({ workspaceId: id }, "Workspace updated");
    return updated;
  },

  delete(id: string): boolean {
    const existing = this.getById(id);
    if (!existing) return false;

    getDatabase().delete(workspaces).where(eq(workspaces.id, id)).run();
    log.info({ workspaceId: id }, "Workspace deleted");
    return true;
  },

  count(): number {
    const result = getDatabase()
      .select({ count: sql<number>`count(*)` })
      .from(workspaces)
      .get();
    return result?.count ?? 0;
  },
};

function rowToSandbox(row: typeof sandboxes.$inferSelect): Sandbox {
  return {
    id: row.id,
    workspaceId: row.workspaceId ?? undefined,
    status: row.status,
    runtime: row.runtime,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const SandboxRepository = {
  getAll(): Sandbox[] {
    return getDatabase().select().from(sandboxes).all().map(rowToSandbox);
  },

  getById(id: string): Sandbox | undefined {
    const row = getDatabase()
      .select()
      .from(sandboxes)
      .where(eq(sandboxes.id, id))
      .get();
    return row ? rowToSandbox(row) : undefined;
  },

  getByStatus(status: SandboxStatus): Sandbox[] {
    return getDatabase()
      .select()
      .from(sandboxes)
      .where(eq(sandboxes.status, status))
      .all()
      .map(rowToSandbox);
  },

  getByWorkspaceId(workspaceId: string): Sandbox[] {
    return getDatabase()
      .select()
      .from(sandboxes)
      .where(eq(sandboxes.workspaceId, workspaceId))
      .all()
      .map(rowToSandbox);
  },

  create(sandbox: Sandbox): Sandbox {
    getDatabase()
      .insert(sandboxes)
      .values({
        id: sandbox.id,
        workspaceId: sandbox.workspaceId ?? null,
        status: sandbox.status,
        runtime: sandbox.runtime,
        createdAt: sandbox.createdAt,
        updatedAt: sandbox.updatedAt,
      })
      .run();
    log.info({ sandboxId: sandbox.id }, "Sandbox created in database");
    return sandbox;
  },

  update(id: string, updates: Partial<Sandbox>): Sandbox {
    const existing = this.getById(id);
    if (!existing) throw new Error(`Sandbox '${id}' not found`);

    const updated: Sandbox = {
      ...existing,
      ...updates,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };

    getDatabase()
      .update(sandboxes)
      .set({
        workspaceId: updated.workspaceId ?? null,
        status: updated.status,
        runtime: updated.runtime,
        updatedAt: updated.updatedAt,
      })
      .where(eq(sandboxes.id, id))
      .run();

    log.debug({ sandboxId: id }, "Sandbox updated in database");
    return updated;
  },

  updateStatus(id: string, status: SandboxStatus, error?: string): Sandbox {
    const existing = this.getById(id);
    if (!existing) throw new Error(`Sandbox '${id}' not found`);

    const runtime = error ? { ...existing.runtime, error } : existing.runtime;

    return this.update(id, { status, runtime });
  },

  delete(id: string): boolean {
    const existing = this.getById(id);
    if (!existing) return false;

    getDatabase().delete(sandboxes).where(eq(sandboxes.id, id)).run();
    log.info({ sandboxId: id }, "Sandbox deleted from database");
    return true;
  },

  count(): number {
    const result = getDatabase()
      .select({ count: sql<number>`count(*)` })
      .from(sandboxes)
      .get();
    return result?.count ?? 0;
  },

  countByStatus(status: SandboxStatus): number {
    const result = getDatabase()
      .select({ count: sql<number>`count(*)` })
      .from(sandboxes)
      .where(eq(sandboxes.status, status))
      .get();
    return result?.count ?? 0;
  },
};
