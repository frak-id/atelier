import { Database } from "bun:sqlite";
import type {
  PrebuildStatus,
  Project,
  Sandbox,
  SandboxStatus,
} from "@frak-sandbox/shared/types";
import { createChildLogger } from "../lib/logger.ts";
import { appPaths, ensureAppDirs } from "../lib/paths.ts";

const log = createChildLogger("database");

let db: Database | null = null;

export async function initDatabase(): Promise<Database> {
  if (db) return db;

  await ensureAppDirs();

  db = new Database(appPaths.database, { create: true });
  db.exec("PRAGMA journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS sandboxes (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      project_id TEXT,
      branch TEXT,
      ip_address TEXT NOT NULL,
      mac_address TEXT NOT NULL,
      urls_vscode TEXT NOT NULL,
      urls_opencode TEXT NOT NULL,
      urls_ssh TEXT NOT NULL,
      vcpus INTEGER NOT NULL,
      memory_mb INTEGER NOT NULL,
      pid INTEGER,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      git_url TEXT NOT NULL,
      default_branch TEXT NOT NULL,
      base_image TEXT NOT NULL,
      vcpus INTEGER NOT NULL,
      memory_mb INTEGER NOT NULL,
      init_commands TEXT NOT NULL,
      start_commands TEXT NOT NULL,
      secrets TEXT NOT NULL,
      exposed_ports TEXT NOT NULL,
      latest_prebuild_id TEXT,
      prebuild_status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  log.info({ path: appPaths.database }, "Database initialized");
  return db;
}

export function getDatabase(): Database {
  if (!db)
    throw new Error("Database not initialized. Call initDatabase() first.");
  return db;
}

function sandboxToRow(s: Sandbox) {
  return {
    $id: s.id,
    $status: s.status,
    $project_id: s.projectId ?? null,
    $branch: s.branch ?? null,
    $ip_address: s.ipAddress,
    $mac_address: s.macAddress,
    $urls_vscode: s.urls.vscode,
    $urls_opencode: s.urls.opencode,
    $urls_ssh: s.urls.ssh,
    $vcpus: s.resources.vcpus,
    $memory_mb: s.resources.memoryMb,
    $pid: s.pid ?? null,
    $error: s.error ?? null,
    $created_at: s.createdAt,
    $updated_at: s.updatedAt,
  };
}

function rowToSandbox(row: Record<string, unknown>): Sandbox {
  return {
    id: row.id as string,
    status: row.status as SandboxStatus,
    projectId: (row.project_id as string | null) ?? undefined,
    branch: (row.branch as string | null) ?? undefined,
    ipAddress: row.ip_address as string,
    macAddress: row.mac_address as string,
    urls: {
      vscode: row.urls_vscode as string,
      opencode: row.urls_opencode as string,
      ssh: row.urls_ssh as string,
    },
    resources: {
      vcpus: row.vcpus as number,
      memoryMb: row.memory_mb as number,
    },
    pid: (row.pid as number | null) ?? undefined,
    error: (row.error as string | null) ?? undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function projectToRow(p: Project) {
  return {
    $id: p.id,
    $name: p.name,
    $git_url: p.gitUrl,
    $default_branch: p.defaultBranch,
    $base_image: p.baseImage,
    $vcpus: p.vcpus,
    $memory_mb: p.memoryMb,
    $init_commands: JSON.stringify(p.initCommands),
    $start_commands: JSON.stringify(p.startCommands),
    $secrets: JSON.stringify(p.secrets),
    $exposed_ports: JSON.stringify(p.exposedPorts),
    $latest_prebuild_id: p.latestPrebuildId ?? null,
    $prebuild_status: p.prebuildStatus,
    $created_at: p.createdAt,
    $updated_at: p.updatedAt,
  };
}

function rowToProject(row: Record<string, unknown>): Project {
  return {
    id: row.id as string,
    name: row.name as string,
    gitUrl: row.git_url as string,
    defaultBranch: row.default_branch as string,
    baseImage: row.base_image as Project["baseImage"],
    vcpus: row.vcpus as number,
    memoryMb: row.memory_mb as number,
    initCommands: JSON.parse(row.init_commands as string),
    startCommands: JSON.parse(row.start_commands as string),
    secrets: JSON.parse(row.secrets as string),
    exposedPorts: JSON.parse(row.exposed_ports as string),
    latestPrebuildId: (row.latest_prebuild_id as string | null) ?? undefined,
    prebuildStatus: row.prebuild_status as PrebuildStatus,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export const SandboxRepository = {
  getAll(): Sandbox[] {
    const rows = getDatabase().query("SELECT * FROM sandboxes").all();
    return rows.map((row) => rowToSandbox(row as Record<string, unknown>));
  },

  getById(id: string): Sandbox | undefined {
    const row = getDatabase()
      .query("SELECT * FROM sandboxes WHERE id = $id")
      .get({ $id: id });
    return row ? rowToSandbox(row as Record<string, unknown>) : undefined;
  },

  getByStatus(status: SandboxStatus): Sandbox[] {
    const rows = getDatabase()
      .query("SELECT * FROM sandboxes WHERE status = $status")
      .all({ $status: status });
    return rows.map((row) => rowToSandbox(row as Record<string, unknown>));
  },

  getByProjectId(projectId: string): Sandbox[] {
    const rows = getDatabase()
      .query("SELECT * FROM sandboxes WHERE project_id = $project_id")
      .all({ $project_id: projectId });
    return rows.map((row) => rowToSandbox(row as Record<string, unknown>));
  },

  create(sandbox: Sandbox): Sandbox {
    getDatabase()
      .query(
        `INSERT INTO sandboxes (
          id, status, project_id, branch, ip_address, mac_address,
          urls_vscode, urls_opencode, urls_ssh, vcpus, memory_mb,
          pid, error, created_at, updated_at
        ) VALUES (
          $id, $status, $project_id, $branch, $ip_address, $mac_address,
          $urls_vscode, $urls_opencode, $urls_ssh, $vcpus, $memory_mb,
          $pid, $error, $created_at, $updated_at
        )`,
      )
      .run(sandboxToRow(sandbox));
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
      .query(
        `UPDATE sandboxes SET
          status = $status, project_id = $project_id, branch = $branch,
          ip_address = $ip_address, mac_address = $mac_address,
          urls_vscode = $urls_vscode, urls_opencode = $urls_opencode, urls_ssh = $urls_ssh,
          vcpus = $vcpus, memory_mb = $memory_mb, pid = $pid, error = $error,
          updated_at = $updated_at
        WHERE id = $id`,
      )
      .run(sandboxToRow(updated));

    log.debug({ sandboxId: id }, "Sandbox updated in database");
    return updated;
  },

  updateStatus(id: string, status: SandboxStatus, error?: string): Sandbox {
    return this.update(id, { status, error });
  },

  delete(id: string): boolean {
    const result = getDatabase()
      .query("DELETE FROM sandboxes WHERE id = $id")
      .run({ $id: id });
    if (result.changes > 0) {
      log.info({ sandboxId: id }, "Sandbox deleted from database");
      return true;
    }
    return false;
  },

  count(): number {
    const row = getDatabase()
      .query("SELECT COUNT(*) as count FROM sandboxes")
      .get() as { count: number };
    return row.count;
  },

  countByStatus(status: SandboxStatus): number {
    const row = getDatabase()
      .query("SELECT COUNT(*) as count FROM sandboxes WHERE status = $status")
      .get({ $status: status }) as { count: number };
    return row.count;
  },
};

export const ProjectRepository = {
  getAll(): Project[] {
    const rows = getDatabase().query("SELECT * FROM projects").all();
    return rows.map((row) => rowToProject(row as Record<string, unknown>));
  },

  getById(id: string): Project | undefined {
    const row = getDatabase()
      .query("SELECT * FROM projects WHERE id = $id")
      .get({ $id: id });
    return row ? rowToProject(row as Record<string, unknown>) : undefined;
  },

  getByPrebuildStatus(status: PrebuildStatus): Project[] {
    const rows = getDatabase()
      .query("SELECT * FROM projects WHERE prebuild_status = $status")
      .all({ $status: status });
    return rows.map((row) => rowToProject(row as Record<string, unknown>));
  },

  create(project: Project): Project {
    getDatabase()
      .query(
        `INSERT INTO projects (
          id, name, git_url, default_branch, base_image, vcpus, memory_mb,
          init_commands, start_commands, secrets, exposed_ports,
          latest_prebuild_id, prebuild_status, created_at, updated_at
        ) VALUES (
          $id, $name, $git_url, $default_branch, $base_image, $vcpus, $memory_mb,
          $init_commands, $start_commands, $secrets, $exposed_ports,
          $latest_prebuild_id, $prebuild_status, $created_at, $updated_at
        )`,
      )
      .run(projectToRow(project));
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
      .query(
        `UPDATE projects SET
          name = $name, git_url = $git_url, default_branch = $default_branch,
          base_image = $base_image, vcpus = $vcpus, memory_mb = $memory_mb,
          init_commands = $init_commands, start_commands = $start_commands,
          secrets = $secrets, exposed_ports = $exposed_ports,
          latest_prebuild_id = $latest_prebuild_id, prebuild_status = $prebuild_status,
          updated_at = $updated_at
        WHERE id = $id`,
      )
      .run(projectToRow(updated));

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
    const result = getDatabase()
      .query("DELETE FROM projects WHERE id = $id")
      .run({ $id: id });
    if (result.changes > 0) {
      log.info({ projectId: id }, "Project deleted from database");
      return true;
    }
    return false;
  },

  count(): number {
    const row = getDatabase()
      .query("SELECT COUNT(*) as count FROM projects")
      .get() as { count: number };
    return row.count;
  },
};
