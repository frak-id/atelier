import { $ } from "bun";
import type { GitSourceService } from "../modules/git-source/index.ts";
import type { WorkspaceService } from "../modules/workspace/index.ts";
import type { GitHubSourceConfig, RepoConfig } from "../schemas/index.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import type { PrebuildRunner } from "./prebuild-runner.ts";

const log = createChildLogger("prebuild-checker");

interface PrebuildCheckerDependencies {
  workspaceService: WorkspaceService;
  gitSourceService: GitSourceService;
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

    for (const repo of workspace.config.repos) {
      const clonePath = repo.clonePath;
      const storedHash = storedHashes[clonePath];

      if (!storedHash) {
        log.debug({ workspaceId, clonePath }, "No stored hash for repo");
        return true;
      }

      const remoteHash = await this.getRemoteCommitHash(repo);
      if (!remoteHash) {
        log.warn({ workspaceId, clonePath }, "Failed to fetch remote hash");
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

    return false;
  }

  private async getRemoteCommitHash(repo: RepoConfig): Promise<string | null> {
    const gitUrl = await this.buildGitUrl(repo);
    const branch = repo.branch;

    const result = await $`git ls-remote ${gitUrl} refs/heads/${branch}`
      .quiet()
      .nothrow();

    if (result.exitCode !== 0) {
      log.warn({ branch, exitCode: result.exitCode }, "git ls-remote failed");
      return null;
    }

    const output = result.stdout.toString().trim();
    if (!output) return null;

    const hash = output.split("\t")[0];
    return hash || null;
  }

  private async buildGitUrl(repo: RepoConfig): Promise<string> {
    if ("url" in repo) {
      return repo.url;
    }

    const source = this.deps.gitSourceService.getById(repo.sourceId);
    if (!source) {
      log.warn({ sourceId: repo.sourceId }, "Git source not found");
      return `https://github.com/${repo.repo}.git`;
    }

    if (source.type === "github") {
      const ghConfig = source.config as GitHubSourceConfig;
      if (ghConfig.accessToken) {
        return `https://x-access-token:${ghConfig.accessToken}@github.com/${repo.repo}.git`;
      }
    }

    return `https://github.com/${repo.repo}.git`;
  }
}
