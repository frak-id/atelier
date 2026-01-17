import type {
  ConfigFile,
  CreateConfigFileOptions,
  MergedConfigFile,
  UpdateConfigFileOptions,
} from "@frak-sandbox/shared/types";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { configFiles } from "../db/schema.ts";
import { createChildLogger } from "../lib/logger.ts";
import { getDatabase } from "../state/database.ts";

const log = createChildLogger("config-files");

function rowToConfigFile(row: typeof configFiles.$inferSelect): ConfigFile {
  return {
    id: row.id,
    path: row.path,
    content: row.content,
    contentType: row.contentType,
    scope: row.scope,
    projectId: row.projectId ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const ConfigFilesService = {
  list(filters?: { scope?: string; projectId?: string }): ConfigFile[] {
    const db = getDatabase();
    let query = db.select().from(configFiles);

    if (filters?.scope === "global") {
      query = query.where(eq(configFiles.scope, "global")) as typeof query;
    } else if (filters?.scope === "project" && filters.projectId) {
      query = query.where(
        and(
          eq(configFiles.scope, "project"),
          eq(configFiles.projectId, filters.projectId),
        ),
      ) as typeof query;
    } else if (filters?.projectId) {
      query = query.where(
        eq(configFiles.projectId, filters.projectId),
      ) as typeof query;
    }

    return query.all().map(rowToConfigFile);
  },

  getById(id: string): ConfigFile | undefined {
    const db = getDatabase();
    const row = db
      .select()
      .from(configFiles)
      .where(eq(configFiles.id, id))
      .get();
    return row ? rowToConfigFile(row) : undefined;
  },

  getByPath(
    path: string,
    scope: "global" | "project",
    projectId?: string,
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

    if (scope === "project" && projectId) {
      const row = db
        .select()
        .from(configFiles)
        .where(
          and(
            eq(configFiles.path, path),
            eq(configFiles.scope, "project"),
            eq(configFiles.projectId, projectId),
          ),
        )
        .get();
      return row ? rowToConfigFile(row) : undefined;
    }

    return undefined;
  },

  create(options: CreateConfigFileOptions): ConfigFile {
    const db = getDatabase();
    const now = new Date().toISOString();

    const existing = this.getByPath(
      options.path,
      options.scope,
      options.projectId,
    );
    if (existing) {
      throw new Error(
        `Config file already exists at path: ${options.path} (scope: ${options.scope})`,
      );
    }

    const row: typeof configFiles.$inferInsert = {
      id: nanoid(12),
      path: options.path,
      content: options.content,
      contentType: options.contentType,
      scope: options.scope,
      projectId: options.projectId ?? null,
      createdAt: now,
      updatedAt: now,
    };

    db.insert(configFiles).values(row).run();
    log.info(
      { id: row.id, path: options.path, scope: options.scope },
      "Config file created",
    );

    return rowToConfigFile(row as typeof configFiles.$inferSelect);
  },

  update(id: string, options: UpdateConfigFileOptions): ConfigFile {
    const db = getDatabase();
    const existing = this.getById(id);
    if (!existing) {
      throw new Error(`Config file not found: ${id}`);
    }

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

    const updated = this.getById(id);
    if (!updated) {
      throw new Error(`Config file not found after update: ${id}`);
    }
    return updated;
  },

  delete(id: string): void {
    const db = getDatabase();
    const existing = this.getById(id);
    if (!existing) {
      throw new Error(`Config file not found: ${id}`);
    }

    db.delete(configFiles).where(eq(configFiles.id, id)).run();
    log.info({ id, path: existing.path }, "Config file deleted");
  },

  getMergedForSandbox(projectId?: string): MergedConfigFile[] {
    const globalConfigs = this.list({ scope: "global" });
    const projectConfigs = projectId
      ? this.list({ scope: "project", projectId })
      : [];

    const pathMap = new Map<string, MergedConfigFile>();

    for (const config of globalConfigs) {
      pathMap.set(config.path, {
        path: config.path,
        content: config.content,
        contentType: config.contentType,
      });
    }

    for (const config of projectConfigs) {
      const existing = pathMap.get(config.path);

      if (!existing) {
        pathMap.set(config.path, {
          path: config.path,
          content: config.content,
          contentType: config.contentType,
        });
      } else if (
        config.contentType === "json" &&
        existing.contentType === "json"
      ) {
        try {
          const globalObj = JSON.parse(existing.content);
          const projectObj = JSON.parse(config.content);
          const merged = deepMerge(globalObj, projectObj);
          pathMap.set(config.path, {
            path: config.path,
            content: JSON.stringify(merged),
            contentType: "json",
          });
        } catch {
          pathMap.set(config.path, {
            path: config.path,
            content: config.content,
            contentType: config.contentType,
          });
        }
      } else {
        pathMap.set(config.path, {
          path: config.path,
          content: config.content,
          contentType: config.contentType,
        });
      }
    }

    return Array.from(pathMap.values());
  },
};

function deepMerge(target: unknown, source: unknown): unknown {
  if (isObject(target) && isObject(source)) {
    const result: Record<string, unknown> = { ...target };
    for (const key of Object.keys(source)) {
      if (isObject(source[key]) && isObject(target[key])) {
        result[key] = deepMerge(target[key], source[key]);
      } else {
        result[key] = source[key];
      }
    }
    return result;
  }
  return source;
}

function isObject(item: unknown): item is Record<string, unknown> {
  return item !== null && typeof item === "object" && !Array.isArray(item);
}
