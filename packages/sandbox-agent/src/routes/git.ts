import { Elysia } from "elysia";
import type { GitRepoStatus } from "../types";
import { loadConfig } from "../utils/config";
import { exec } from "../utils/exec";

function gitCmd(repoPath: string, cmd: string): string {
  return `su - dev -c 'git -C "${repoPath}" ${cmd}'`;
}

export const gitRoutes = new Elysia().get("/git/status", async () => {
  const config = await loadConfig();
  const repos = config?.repos ?? [];

  const results: GitRepoStatus[] = [];

  for (const repo of repos) {
    const repoPath = `/home/dev${repo.clonePath}`;
    try {
      const { stdout: isGit } = await exec(
        `${gitCmd(repoPath, "rev-parse --git-dir")} 2>/dev/null || echo "not-git"`,
      );
      if (isGit.trim() === "not-git") {
        results.push({
          path: repo.clonePath,
          branch: null,
          dirty: false,
          ahead: 0,
          behind: 0,
          lastCommit: null,
          error: "Not a git repository",
        });
        continue;
      }

      const { stdout: branch } = await exec(
        `${gitCmd(repoPath, "branch --show-current")} 2>/dev/null || echo ""`,
      );

      const { stdout: status } = await exec(
        `${gitCmd(repoPath, "status --porcelain")} 2>/dev/null || echo ""`,
      );
      const dirty = status.trim().length > 0;

      let ahead = 0;
      let behind = 0;
      try {
        const { stdout: counts } = await exec(
          `${gitCmd(repoPath, "rev-list --left-right --count HEAD...@{upstream}")} 2>/dev/null || echo "0 0"`,
        );
        const [a, b] = counts.trim().split(/\s+/);
        ahead = parseInt(a || "0", 10);
        behind = parseInt(b || "0", 10);
      } catch {
        /* empty */
      }

      const { stdout: lastCommit } = await exec(
        `${gitCmd(repoPath, 'log -1 --format="%h %s"')} 2>/dev/null || echo ""`,
      );

      results.push({
        path: repo.clonePath,
        branch: branch.trim() || null,
        dirty,
        ahead,
        behind,
        lastCommit: lastCommit.trim() || null,
      });
    } catch (error) {
      results.push({
        path: repo.clonePath,
        branch: null,
        dirty: false,
        ahead: 0,
        behind: 0,
        lastCommit: null,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  return { repos: results };
});
