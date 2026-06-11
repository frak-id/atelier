import type { UserService } from "../modules/user/index.ts";
import type { WorkspaceService } from "../modules/workspace/index.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import { getRemoteCommitHash } from "./ports/git-remote.ts";
import type { PrebuildRunner } from "./prebuild-runner.ts";

const log = createChildLogger("prebuild-checker");

interface PrebuildCheckerDependencies {
  workspaceService: WorkspaceService;
  userService: UserService;
  prebuildRunner: PrebuildRunner;
}

export class PrebuildChecker {
  constructor(private readonly deps: PrebuildCheckerDependencies) {}

  async checkAllAndRebuildStale(): Promise<void> {
    const workspaces = this.deps.workspaceService.getAll();
    const now = new Date().toISOString();

    for (const workspace of workspaces) {
      if (workspace.config.prebuild?.status !== "ready") continue;
      if (!workspace.config.repos?.length) continue;

      try {
        const isStale = await this.isWorkspacePrebuildStale(workspace.id);

        this.deps.workspaceService.update(workspace.id, {
          config: {
            ...workspace.config,
            prebuild: {
              ...workspace.config.prebuild,
              lastCheckedAt: now,
              stale: isStale,
            },
          },
        });

        if (isStale) {
          log.info(
            { workspaceId: workspace.id },
            "Prebuild is stale, triggering rebuild",
          );
          this.deps.prebuildRunner.runInBackground(workspace.id);
        }
      } catch (error) {
        log.error(
          { workspaceId: workspace.id, error },
          "Failed to check prebuild freshness",
        );
      }
    }
  }

  async isWorkspacePrebuildStale(workspaceId: string): Promise<boolean> {
    const workspace = this.deps.workspaceService.getById(workspaceId);
    if (!workspace) return false;

    const storedHashes = workspace.config.prebuild?.commitHashes ?? {};
    if (Object.keys(storedHashes).length === 0) {
      return true;
    }

    const githubToken = this.deps.userService.resolveGitHubToken();
    let fetchFailures = 0;

    for (const repo of workspace.config.repos) {
      const clonePath = repo.clonePath;
      const storedHash = storedHashes[clonePath];

      if (!storedHash) {
        log.debug({ workspaceId, clonePath }, "No stored hash for repo");
        return true;
      }

      const remoteHash = await getRemoteCommitHash(repo, githubToken);
      if (!remoteHash) {
        log.warn({ workspaceId, clonePath }, "Failed to fetch remote hash");
        fetchFailures++;
        continue;
      }

      if (remoteHash !== storedHash) {
        log.info(
          { workspaceId, clonePath, storedHash, remoteHash },
          "Commit hash mismatch detected",
        );
        return true;
      }
    }

    if (fetchFailures === workspace.config.repos.length) {
      throw new Error(
        `Failed to fetch remote hashes for all ${fetchFailures} repos — ` +
          "git may not be available in the manager container",
      );
    }

    return false;
  }
}
