import { nanoid } from "nanoid";
import { StorageService } from "../../infrastructure/storage/index.ts";
import type { Workspace, WorkspaceConfig } from "../../schemas/index.ts";
import { DEFAULT_WORKSPACE_CONFIG } from "../../schemas/index.ts";
import { NotFoundError } from "../../shared/errors.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import { WorkspaceRepository } from "./workspace.repository.ts";

const log = createChildLogger("workspace-service");

type PrebuildCreator = (workspaceId: string) => void;

let prebuildCreator: PrebuildCreator | null = null;

export function setPrebuildCreator(creator: PrebuildCreator): void {
  prebuildCreator = creator;
}

export const WorkspaceService = {
  getAll(): Workspace[] {
    return WorkspaceRepository.getAll();
  },

  getById(id: string): Workspace | undefined {
    return WorkspaceRepository.getById(id);
  },

  getByIdOrThrow(id: string): Workspace {
    const workspace = WorkspaceRepository.getById(id);
    if (!workspace) {
      throw new NotFoundError("Workspace", id);
    }
    return workspace;
  },

  create(name: string, partialConfig?: Partial<WorkspaceConfig>): Workspace {
    const now = new Date().toISOString();
    const config: WorkspaceConfig = {
      ...DEFAULT_WORKSPACE_CONFIG,
      ...partialConfig,
    };

    const workspace: Workspace = {
      id: nanoid(12),
      name,
      config,
      createdAt: now,
      updatedAt: now,
    };

    log.info(
      { workspaceId: workspace.id, name: workspace.name },
      "Creating workspace",
    );
    WorkspaceRepository.create(workspace);

    if (config.repos && config.repos.length > 0 && prebuildCreator) {
      log.info({ workspaceId: workspace.id }, "Triggering initial prebuild");
      prebuildCreator(workspace.id);
    }

    return workspace;
  },

  update(
    id: string,
    updates: { name?: string; config?: Partial<WorkspaceConfig> },
  ): Workspace {
    const existing = this.getByIdOrThrow(id);

    log.info({ workspaceId: id }, "Updating workspace");

    const workspaceUpdates: Partial<Workspace> = {};
    if (updates.name !== undefined) {
      workspaceUpdates.name = updates.name;
    }
    if (updates.config !== undefined) {
      workspaceUpdates.config = {
        ...existing.config,
        ...updates.config,
      } as WorkspaceConfig;
    }

    return WorkspaceRepository.update(id, workspaceUpdates);
  },

  async delete(id: string): Promise<void> {
    this.getByIdOrThrow(id);

    log.info({ workspaceId: id }, "Deleting workspace");
    await StorageService.deletePrebuild(id);
    WorkspaceRepository.delete(id);
  },

  count(): number {
    return WorkspaceRepository.count();
  },
};
