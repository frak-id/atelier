import { eventBus } from "../../infrastructure/events/index.ts";
import type { Workspace, WorkspaceConfig } from "../../schemas/index.ts";
import { DEFAULT_WORKSPACE_CONFIG } from "../../schemas/index.ts";
import { NotFoundError } from "../../shared/errors.ts";
import { safeNanoid } from "../../shared/lib/id.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import type { WorkspaceRepository } from "./workspace.repository.ts";

const log = createChildLogger("workspace-service");

export class WorkspaceService {
  constructor(private readonly workspaceRepository: WorkspaceRepository) {}

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
    const workspaceConfig: WorkspaceConfig = {
      ...DEFAULT_WORKSPACE_CONFIG,
      ...partialConfig,
    };

    const workspace: Workspace = {
      id: safeNanoid(12),
      name,
      config: workspaceConfig,
      createdAt: now,
      updatedAt: now,
    };

    log.info(
      { workspaceId: workspace.id, name: workspace.name },
      "Creating workspace",
    );
    this.workspaceRepository.create(workspace);
    eventBus.emit({
      type: "workspace.created",
      properties: { id: workspace.id },
    });

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

    const updated = this.workspaceRepository.update(id, workspaceUpdates);
    eventBus.emit({
      type: "workspace.updated",
      properties: { id },
    });
    return updated;
  }

  delete(id: string): void {
    this.getByIdOrThrow(id);
    log.info({ workspaceId: id }, "Deleting workspace");
    this.workspaceRepository.delete(id);
    eventBus.emit({
      type: "workspace.deleted",
      properties: { id },
    });
  }

  count(): number {
    return this.workspaceRepository.count();
  }
}
