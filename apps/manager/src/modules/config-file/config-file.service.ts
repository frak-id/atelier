import type {
  ConfigFile,
  ConfigFileContentType,
  ConfigFileScope,
  MergedConfigFile,
} from "../../schemas/index.ts";
import { NotFoundError } from "../../shared/errors.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import type { ConfigFileRepository } from "./config-file.repository.ts";

const log = createChildLogger("config-file-service");

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

export class ConfigFileService {
  constructor(private readonly configFileRepository: ConfigFileRepository) {}

  list(filters?: { scope?: string; workspaceId?: string }): ConfigFile[] {
    return this.configFileRepository.list(filters);
  }

  getById(id: string): ConfigFile | undefined {
    return this.configFileRepository.getById(id);
  }

  getByIdOrThrow(id: string): ConfigFile {
    const file = this.configFileRepository.getById(id);
    if (!file) {
      throw new NotFoundError("ConfigFile", id);
    }
    return file;
  }

  getByPath(
    path: string,
    scope: ConfigFileScope,
    workspaceId?: string,
  ): ConfigFile | undefined {
    return this.configFileRepository.getByPath(path, scope, workspaceId);
  }

  create(options: CreateOptions): ConfigFile {
    const existing = this.configFileRepository.getByPath(
      options.path,
      options.scope,
      options.workspaceId,
    );
    if (existing) {
      throw new Error(
        `Config file already exists at path: ${options.path} (scope: ${options.scope})`,
      );
    }

    return this.configFileRepository.create(options);
  }

  update(id: string, options: UpdateOptions): ConfigFile {
    const existing = this.configFileRepository.getById(id);
    if (!existing) {
      throw new NotFoundError("ConfigFile", id);
    }

    const updated = this.configFileRepository.update(id, options);
    if (!updated) {
      throw new Error(`Failed to update config file: ${id}`);
    }
    return updated;
  }

  delete(id: string): void {
    const existing = this.configFileRepository.getById(id);
    if (!existing) {
      throw new NotFoundError("ConfigFile", id);
    }

    this.configFileRepository.delete(id);
    log.info({ id, path: existing.path }, "Config file deleted");
  }

  extractFromSandbox(
    workspaceId: string | undefined,
    path: string,
    content: string,
    contentType: "json" | "text",
  ): { action: "created" | "updated"; configFile: ConfigFile } {
    const scope: ConfigFileScope = workspaceId ? "workspace" : "global";
    const existing = this.configFileRepository.getByPath(
      path,
      scope,
      workspaceId,
    );

    if (existing) {
      const updated = this.configFileRepository.update(existing.id, {
        content,
        contentType,
      });
      if (!updated) {
        throw new Error(`Failed to update config file: ${existing.id}`);
      }
      return { action: "updated", configFile: updated };
    }

    const created = this.configFileRepository.create({
      path,
      content,
      contentType,
      scope,
      workspaceId,
    });
    return { action: "created", configFile: created };
  }

  getMergedForSandbox(workspaceId?: string): MergedConfigFile[] {
    const globalConfigs = this.configFileRepository.list({ scope: "global" });
    const workspaceConfigs = workspaceId
      ? this.configFileRepository.list({ scope: "workspace", workspaceId })
      : [];

    const pathMap = new Map<string, MergedConfigFile>();

    for (const config of globalConfigs) {
      pathMap.set(config.path, {
        path: config.path,
        content: config.content,
        contentType: config.contentType,
      });
    }

    for (const config of workspaceConfigs) {
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
  }
}

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
