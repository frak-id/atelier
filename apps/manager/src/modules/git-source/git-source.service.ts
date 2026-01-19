import { nanoid } from "nanoid";
import type {
  GitSource,
  GitSourceConfig,
  GitSourceType,
} from "../../schemas/index.ts";
import { NotFoundError } from "../../shared/errors.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import type { GitSourceRepository } from "./git-source.repository.ts";

const log = createChildLogger("git-source-service");

interface GitHubRepo {
  id: string;
  fullName: string;
  cloneUrl: string;
  defaultBranch: string;
  private: boolean;
}

interface GitHubApiRepo {
  id: number;
  full_name: string;
  clone_url: string;
  default_branch: string;
  private: boolean;
}

export class GitSourceService {
  constructor(private readonly gitSourceRepository: GitSourceRepository) {}

  getAll(): GitSource[] {
    return this.gitSourceRepository.getAll();
  }

  getById(id: string): GitSource | undefined {
    return this.gitSourceRepository.getById(id);
  }

  getByIdOrThrow(id: string): GitSource {
    const source = this.gitSourceRepository.getById(id);
    if (!source) {
      throw new NotFoundError("GitSource", id);
    }
    return source;
  }

  create(
    type: GitSourceType,
    name: string,
    config: GitSourceConfig,
  ): GitSource {
    const now = new Date().toISOString();
    const source: GitSource = {
      id: nanoid(12),
      type,
      name,
      config,
      createdAt: now,
      updatedAt: now,
    };

    log.info({ sourceId: source.id, type }, "Creating git source");
    return this.gitSourceRepository.create(source);
  }

  update(
    id: string,
    updates: { name?: string; config?: GitSourceConfig },
  ): GitSource {
    this.getByIdOrThrow(id);

    log.info({ sourceId: id }, "Updating git source");

    const sourceUpdates: Partial<GitSource> = {};
    if (updates.name !== undefined) {
      sourceUpdates.name = updates.name;
    }
    if (updates.config !== undefined) {
      sourceUpdates.config = updates.config;
    }

    return this.gitSourceRepository.update(id, sourceUpdates);
  }

  delete(id: string): void {
    this.getByIdOrThrow(id);
    log.info({ sourceId: id }, "Deleting git source");
    this.gitSourceRepository.delete(id);
  }

  async fetchRepos(id: string): Promise<GitHubRepo[]> {
    const source = this.getByIdOrThrow(id);

    if (source.type === "github") {
      return this.fetchGitHubRepos(source.config as { accessToken: string });
    }

    log.warn({ sourceId: id, type: source.type }, "Unsupported source type");
    return [];
  }

  async fetchGitHubRepos(config: {
    accessToken: string;
  }): Promise<GitHubRepo[]> {
    const response = await fetch(
      "https://api.github.com/user/repos?per_page=100&sort=updated",
      {
        headers: {
          Authorization: `Bearer ${config.accessToken}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const repos = (await response.json()) as GitHubApiRepo[];
    return repos.map((repo) => ({
      id: String(repo.id),
      fullName: repo.full_name,
      cloneUrl: repo.clone_url,
      defaultBranch: repo.default_branch,
      private: repo.private,
    }));
  }

  count(): number {
    return this.gitSourceRepository.count();
  }
}
