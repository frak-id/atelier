import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  configFiles,
  getDatabase,
} from "../../infrastructure/database/index.ts";
import type {
  ConfigFile,
  ConfigFileContentType,
  ConfigFileScope,
} from "../../schemas/index.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";

const log = createChildLogger("config-file-repository");

function rowToConfigFile(row: typeof configFiles.$inferSelect): ConfigFile {
  return {
    id: row.id,
    path: row.path,
    content: row.content,
    contentType: row.contentType,
    scope: row.scope,
    workspaceId: row.workspaceId ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

interface CreateOptions {
  path: string;
  content: string;
  contentType: ConfigFileContentType;
  scope: ConfigFileScope;
  workspaceId?: string;
}

interface UpdateOptions {
  content?: string;
  contentType?: ConfigFileContentType;
}

export class ConfigFileRepository {
  list(filters?: { scope?: string; workspaceId?: string }): ConfigFile[] {
    const db = getDatabase();
    let query = db.select().from(configFiles);

    if (filters?.scope === "global") {
      query = query.where(eq(configFiles.scope, "global")) as typeof query;
    } else if (filters?.scope === "workspace" && filters.workspaceId) {
      query = query.where(
        and(
          eq(configFiles.scope, "workspace"),
          eq(configFiles.workspaceId, filters.workspaceId),
        ),
      ) as typeof query;
    } else if (filters?.workspaceId) {
      query = query.where(
        eq(configFiles.workspaceId, filters.workspaceId),
      ) as typeof query;
    }

    return query.all().map(rowToConfigFile);
  }

  getById(id: string): ConfigFile | undefined {
    const db = getDatabase();
    const row = db
      .select()
      .from(configFiles)
      .where(eq(configFiles.id, id))
      .get();
    return row ? rowToConfigFile(row) : undefined;
  }

  getByPath(
    path: string,
    scope: ConfigFileScope,
    workspaceId?: string,
  ): ConfigFile | undefined {
    const db = getDatabase();

    if (scope === "global") {
      const row = db
        .select()
        .from(configFiles)
        .where(and(eq(configFiles.path, path), eq(configFiles.scope, "global")))
        .get();
      return row ? rowToConfigFile(row) : undefined;
    }

    if (scope === "workspace" && workspaceId) {
      const row = db
        .select()
        .from(configFiles)
        .where(
          and(
            eq(configFiles.path, path),
            eq(configFiles.scope, "workspace"),
            eq(configFiles.workspaceId, workspaceId),
          ),
        )
        .get();
      return row ? rowToConfigFile(row) : undefined;
    }

    return undefined;
  }

  create(options: CreateOptions): ConfigFile {
    const db = getDatabase();
    const now = new Date().toISOString();

    const row: typeof configFiles.$inferInsert = {
      id: nanoid(12),
      path: options.path,
      content: options.content,
      contentType: options.contentType,
      scope: options.scope,
      workspaceId: options.workspaceId ?? null,
      createdAt: now,
      updatedAt: now,
    };

    db.insert(configFiles).values(row).run();
    log.info(
      { id: row.id, path: options.path, scope: options.scope },
      "Config file created",
    );

    return rowToConfigFile(row as typeof configFiles.$inferSelect);
  }

  update(id: string, options: UpdateOptions): ConfigFile | undefined {
    const db = getDatabase();
    const existing = this.getById(id);
    if (!existing) return undefined;

    const now = new Date().toISOString();
    const updates: Partial<typeof configFiles.$inferInsert> = {
      updatedAt: now,
    };

    if (options.content !== undefined) {
      updates.content = options.content;
    }
    if (options.contentType !== undefined) {
      updates.contentType = options.contentType;
    }

    db.update(configFiles).set(updates).where(eq(configFiles.id, id)).run();
    log.info({ id, path: existing.path }, "Config file updated");

    return this.getById(id);
  }

  delete(id: string): boolean {
    const db = getDatabase();
    const existing = this.getById(id);
    if (!existing) return false;

    db.delete(configFiles).where(eq(configFiles.id, id)).run();
    log.info({ id, path: existing.path }, "Config file deleted");
    return true;
  }
}
