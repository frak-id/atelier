import { nanoid } from "nanoid";
import { StorageService } from "../../infrastructure/storage/index.ts";
import type { Workspace, WorkspaceConfig } from "../../schemas/index.ts";
import { DEFAULT_WORKSPACE_CONFIG } from "../../schemas/index.ts";
import { NotFoundError } from "../../shared/errors.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import type { WorkspaceRepository } from "./workspace.repository.ts";

const log = createChildLogger("workspace-service");

export class WorkspaceService {
  constructor(
    private readonly workspaceRepository: WorkspaceRepository,
    private readonly prebuildCreator?: (workspaceId: string) => void,
  ) {}

  getAll(): Workspace[] {
    return this.workspaceRepository.getAll();
  }

  getById(id: string): Workspace | undefined {
    return this.workspaceRepository.getById(id);
  }

  getByIdOrThrow(id: string): Workspace {
    const workspace = this.workspaceRepository.getById(id);
    if (!workspace) {
      throw new NotFoundError("Workspace", id);
    }
    return workspace;
  }

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
    this.workspaceRepository.create(workspace);

    if (config.repos && config.repos.length > 0 && this.prebuildCreator) {
      log.info({ workspaceId: workspace.id }, "Triggering initial prebuild");
      this.prebuildCreator(workspace.id);
    }

    return workspace;
  }

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

    return this.workspaceRepository.update(id, workspaceUpdates);
  }

  async delete(id: string): Promise<void> {
    this.getByIdOrThrow(id);

    log.info({ workspaceId: id }, "Deleting workspace");
    await StorageService.deletePrebuild(id);
    this.workspaceRepository.delete(id);
  }

  count(): number {
    return this.workspaceRepository.count();
  }
}
