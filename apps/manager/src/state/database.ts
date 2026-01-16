import { Database } from "bun:sqlite";
import type {
  Project,
  Sandbox,
  SandboxStatus,
} from "@frak-sandbox/shared/types";
import { eq, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import {
  type PrebuildStatus,
  type ProjectRow,
  projects,
  type SandboxRow,
  sandboxes,
} from "../db/schema.ts";
import { createChildLogger } from "../lib/logger.ts";
import { appPaths, ensureAppDirs } from "../lib/paths.ts";

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

function rowToSandbox(row: SandboxRow): Sandbox {
  return {
    id: row.id,
    status: row.status,
    projectId: row.projectId ?? undefined,
    branch: row.branch ?? undefined,
    ipAddress: row.ipAddress,
    macAddress: row.macAddress,
    urls: {
      vscode: row.urlsVscode,
      opencode: row.urlsOpencode,
      ssh: row.urlsSsh,
    },
    resources: {
      vcpus: row.vcpus,
      memoryMb: row.memoryMb,
    },
    pid: row.pid ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function sandboxToRow(s: Sandbox): typeof sandboxes.$inferInsert {
  return {
    id: s.id,
    status: s.status,
    projectId: s.projectId ?? null,
    branch: s.branch ?? null,
    ipAddress: s.ipAddress,
    macAddress: s.macAddress,
    urlsVscode: s.urls.vscode,
    urlsOpencode: s.urls.opencode,
    urlsSsh: s.urls.ssh,
    vcpus: s.resources.vcpus,
    memoryMb: s.resources.memoryMb,
    pid: s.pid ?? null,
    error: s.error ?? null,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    gitUrl: row.gitUrl,
    defaultBranch: row.defaultBranch,
    baseImage: row.baseImage,
    vcpus: row.vcpus,
    memoryMb: row.memoryMb,
    initCommands: row.initCommands,
    startCommands: row.startCommands,
    secrets: row.secrets,
    exposedPorts: row.exposedPorts,
    latestPrebuildId: row.latestPrebuildId ?? undefined,
    prebuildStatus: row.prebuildStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function projectToRow(p: Project): typeof projects.$inferInsert {
  return {
    id: p.id,
    name: p.name,
    gitUrl: p.gitUrl,
    defaultBranch: p.defaultBranch,
    baseImage: p.baseImage,
    vcpus: p.vcpus,
    memoryMb: p.memoryMb,
    initCommands: p.initCommands,
    startCommands: p.startCommands,
    secrets: p.secrets,
    exposedPorts: p.exposedPorts,
    latestPrebuildId: p.latestPrebuildId ?? null,
    prebuildStatus: p.prebuildStatus,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
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

  getByProjectId(projectId: string): Sandbox[] {
    return getDatabase()
      .select()
      .from(sandboxes)
      .where(eq(sandboxes.projectId, projectId))
      .all()
      .map(rowToSandbox);
  },

  create(sandbox: Sandbox): Sandbox {
    getDatabase().insert(sandboxes).values(sandboxToRow(sandbox)).run();
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
      .set(sandboxToRow(updated))
      .where(eq(sandboxes.id, id))
      .run();

    log.debug({ sandboxId: id }, "Sandbox updated in database");
    return updated;
  },

  updateStatus(id: string, status: SandboxStatus, error?: string): Sandbox {
    return this.update(id, { status, error });
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

export const ProjectRepository = {
  getAll(): Project[] {
    return getDatabase().select().from(projects).all().map(rowToProject);
  },

  getById(id: string): Project | undefined {
    const row = getDatabase()
      .select()
      .from(projects)
      .where(eq(projects.id, id))
      .get();
    return row ? rowToProject(row) : undefined;
  },

  getByPrebuildStatus(status: PrebuildStatus): Project[] {
    return getDatabase()
      .select()
      .from(projects)
      .where(eq(projects.prebuildStatus, status))
      .all()
      .map(rowToProject);
  },

  create(project: Project): Project {
    getDatabase().insert(projects).values(projectToRow(project)).run();
    log.info({ projectId: project.id }, "Project created in database");
    return project;
  },

  update(id: string, updates: Partial<Project>): Project {
    const existing = this.getById(id);
    if (!existing) throw new Error(`Project '${id}' not found`);

    const updated: Project = {
      ...existing,
      ...updates,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };

    getDatabase()
      .update(projects)
      .set(projectToRow(updated))
      .where(eq(projects.id, id))
      .run();

    log.debug({ projectId: id }, "Project updated in database");
    return updated;
  },

  updatePrebuildStatus(
    id: string,
    status: PrebuildStatus,
    prebuildId?: string,
  ): Project {
    return this.update(id, {
      prebuildStatus: status,
      ...(prebuildId && { latestPrebuildId: prebuildId }),
    });
  },

  delete(id: string): boolean {
    const existing = this.getById(id);
    if (!existing) return false;

    getDatabase().delete(projects).where(eq(projects.id, id)).run();
    log.info({ projectId: id }, "Project deleted from database");
    return true;
  },

  count(): number {
    const result = getDatabase()
      .select({ count: sql<number>`count(*)` })
      .from(projects)
      .get();
    return result?.count ?? 0;
  },
};
