import { PATHS } from "@frak-sandbox/shared/constants";
import { $ } from "bun";
import { config } from "../lib/config.ts";
import { createChildLogger } from "../lib/logger.ts";
import { ensureDir } from "../lib/shell.ts";

const log = createChildLogger("git");

export const GitService = {
  getCacheDir(gitUrl: string): string {
    const safeName = gitUrl
      .replace(/^https?:\/\//, "")
      .replace(/\.git$/, "")
      .replace(/[/:]/g, "_");
    return `${PATHS.GIT_CACHE_DIR}/${safeName}.git`;
  },

  async hasCachedRepo(gitUrl: string): Promise<boolean> {
    if (config.isMock()) return false;

    const cacheDir = this.getCacheDir(gitUrl);
    const result = await $`test -d ${cacheDir}`.quiet().nothrow();
    return result.exitCode === 0;
  },

  async updateCache(gitUrl: string): Promise<void> {
    if (config.isMock()) {
      log.debug({ gitUrl }, "Mock: git cache update");
      return;
    }

    await ensureDir(PATHS.GIT_CACHE_DIR);
    const cacheDir = this.getCacheDir(gitUrl);

    if (await this.hasCachedRepo(gitUrl)) {
      log.info({ gitUrl, cacheDir }, "Updating git cache");
      await $`git -C ${cacheDir} fetch --all --prune`.quiet();
    } else {
      log.info({ gitUrl, cacheDir }, "Creating git cache");
      await $`git clone --mirror ${gitUrl} ${cacheDir}`.quiet();
    }
  },

  async cloneToDirectory(
    gitUrl: string,
    targetDir: string,
    branch?: string,
  ): Promise<void> {
    if (config.isMock()) {
      log.debug({ gitUrl, targetDir, branch }, "Mock: git clone");
      return;
    }

    const cacheDir = this.getCacheDir(gitUrl);
    const hasCached = await this.hasCachedRepo(gitUrl);
    const cloneSource = hasCached ? cacheDir : gitUrl;
    const branchArgs = branch ? ["-b", branch] : [];

    log.info(
      { gitUrl, targetDir, branch, fromCache: hasCached },
      "Cloning repository",
    );

    await $`git clone ${branchArgs} ${cloneSource} ${targetDir}`.quiet();

    if (hasCached) {
      await $`git -C ${targetDir} remote set-url origin ${gitUrl}`.quiet();
    }

    log.info({ gitUrl, targetDir }, "Clone complete");
  },

  async cloneInVm(
    agentUrl: string,
    gitUrl: string,
    targetDir: string,
    branch?: string,
  ): Promise<{ success: boolean; error?: string }> {
    if (config.isMock()) {
      log.debug({ gitUrl, targetDir, branch }, "Mock: git clone in VM");
      return { success: true };
    }

    const branchArg = branch ? `-b ${branch}` : "";
    const command = `git clone ${branchArg} ${gitUrl} ${targetDir}`.trim();

    log.info({ agentUrl, gitUrl, targetDir, branch }, "Cloning repo in VM");

    try {
      const response = await fetch(`${agentUrl}/exec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command, timeout: 120000 }),
      });

      if (!response.ok) {
        const text = await response.text();
        return { success: false, error: `Agent request failed: ${text}` };
      }

      const result = (await response.json()) as {
        exitCode: number;
        stdout: string;
        stderr: string;
      };

      if (result.exitCode !== 0) {
        log.error({ result }, "Git clone failed in VM");
        return { success: false, error: result.stderr || "Clone failed" };
      }

      log.info({ gitUrl, targetDir }, "Clone in VM complete");
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      log.error({ error: message }, "Failed to clone in VM");
      return { success: false, error: message };
    }
  },

  async deleteCache(gitUrl: string): Promise<void> {
    if (config.isMock()) return;

    const cacheDir = this.getCacheDir(gitUrl);
    await $`rm -rf ${cacheDir}`.quiet().nothrow();
    log.info({ gitUrl, cacheDir }, "Git cache deleted");
  },

  async getCacheStats(): Promise<{
    totalRepos: number;
    totalSizeMb: number;
    repos: Array<{ name: string; sizeMb: number }>;
  }> {
    if (config.isMock()) {
      return { totalRepos: 0, totalSizeMb: 0, repos: [] };
    }

    const result = await $`ls -1 ${PATHS.GIT_CACHE_DIR} 2>/dev/null || true`
      .quiet()
      .nothrow();

    const repos = result.stdout
      .toString()
      .trim()
      .split("\n")
      .filter((name) => name.endsWith(".git"));

    const repoStats = await Promise.all(
      repos.map(async (name) => {
        const sizeResult =
          await $`du -sm ${PATHS.GIT_CACHE_DIR}/${name} 2>/dev/null || echo "0"`
            .quiet()
            .nothrow();
        const sizeMb = parseInt(
          sizeResult.stdout.toString().split("\t")[0] || "0",
          10,
        );
        return { name: name.replace(".git", ""), sizeMb };
      }),
    );

    return {
      totalRepos: repoStats.length,
      totalSizeMb: repoStats.reduce((sum, r) => sum + r.sizeMb, 0),
      repos: repoStats,
    };
  },
};
