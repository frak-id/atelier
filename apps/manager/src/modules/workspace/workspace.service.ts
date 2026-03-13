import { eventBus } from "../../infrastructure/events/index.ts";
import type {
  RepoConfig,
  Workspace,
  WorkspaceConfig,
} from "../../schemas/index.ts";
import { DEFAULT_WORKSPACE_CONFIG } from "../../schemas/index.ts";
import { NotFoundError } from "../../shared/errors.ts";
import { resolveRepoRemoteUrl } from "../../shared/lib/git-url.ts";
import { safeNanoid } from "../../shared/lib/id.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import type { WorkspaceRepository } from "./workspace.repository.ts";

const log = createChildLogger("workspace-service");

export class WorkspaceService {
  constructor(private readonly workspaceRepository: WorkspaceRepository) {}

  getAll(): Workspace[] {
    return this.workspaceRepository.getAll();
  }

  getByOrgId(orgId: string): Workspace[] {
    return this.workspaceRepository.getByOrgId(orgId);
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

  matchByRemoteUrl(remoteUrl: string):
    | {
        workspace: Workspace;
        matchedRepo: RepoConfig;
      }
    | undefined {
    const normalizedInput = resolveRepoRemoteUrl({ url: remoteUrl });
    const allWorkspaces = this.workspaceRepository.getAll();

    for (const workspace of allWorkspaces) {
      for (const repo of workspace.config.repos) {
        const resolved = repo.resolvedRemoteUrl ?? resolveRepoRemoteUrl(repo);
        if (resolved === normalizedInput) {
          return { workspace, matchedRepo: repo };
        }
      }
    }

    return undefined;
  }

  create(
    name: string,
    partialConfig?: Partial<WorkspaceConfig>,
    orgId?: string,
  ): Workspace {
    const now = new Date().toISOString();
    const workspaceConfig: WorkspaceConfig = {
      ...DEFAULT_WORKSPACE_CONFIG,
      ...partialConfig,
    };

    workspaceConfig.repos = this.enrichRepos(workspaceConfig.repos);

    const workspace: Workspace = {
      id: safeNanoid(12),
      orgId,
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
      const mergedConfig = {
        ...existing.config,
        ...updates.config,
      } as WorkspaceConfig;

      if (updates.config.repos) {
        mergedConfig.repos = this.enrichRepos(mergedConfig.repos);
      }

      workspaceUpdates.config = mergedConfig;
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

  private enrichRepos(repos: RepoConfig[]): RepoConfig[] {
    return repos.map((repo) => ({
      ...repo,
      resolvedRemoteUrl: resolveRepoRemoteUrl(repo),
    }));
  }
}
