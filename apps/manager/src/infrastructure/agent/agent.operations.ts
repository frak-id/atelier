import type { AgentClient } from "./agent.client.ts";
import type {
  AgentHealth,
  GitCommitResult,
  GitDiffFile,
  GitDiffRepo,
  GitDiffResult,
  GitPushResult,
  GitRepoStatus,
  GitStatus,
  ServiceStatus,
} from "./agent.types.ts";

export class AgentOperations {
  constructor(private readonly client: AgentClient) {}

  async batchHealth(
    sandboxIds: string[],
  ): Promise<Map<string, AgentHealth | { error: string }>> {
    const results = new Map<string, AgentHealth | { error: string }>();

    await Promise.all(
      sandboxIds.map(async (sandboxId) => {
        try {
          const health = await this.client.health(sandboxId);
          results.set(sandboxId, health);
        } catch (error) {
          results.set(sandboxId, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );

    return results;
  }

  async services(sandboxId: string): Promise<{ services: ServiceStatus[] }> {
    return this.client.serviceList(sandboxId);
  }

  async logs(
    sandboxId: string,
    service: string,
    lines: number = 100,
  ): Promise<{ service: string; content: string }> {
    const result = await this.client.exec(
      sandboxId,
      `tail -n ${lines} /var/log/sandbox/${service}.log 2>/dev/null || echo ""`,
    );
    return { service, content: result.stdout };
  }

  async gitStatus(
    sandboxId: string,
    repos: { clonePath: string }[],
  ): Promise<GitStatus> {
    if (repos.length === 0) return { repos: [] };

    const { results } = await this.client.batchExec(
      sandboxId,
      repos.map((repo, i) => {
        const repoPath = `/home/dev${repo.clonePath}`;
        const script = [
          `cd "${repoPath}" 2>/dev/null || { echo "NOT_GIT"; exit 0; }`,
          `git rev-parse --git-dir >/dev/null 2>&1 || { echo "NOT_GIT"; exit 0; }`,
          `echo "BRANCH=$(git branch --show-current 2>/dev/null)"`,
          `echo "DIRTY=$(git status --porcelain 2>/dev/null | head -1)"`,
          `echo "COUNTS=$(git rev-list --left-right --count HEAD...@{upstream} 2>/dev/null || echo '0 0')"`,
          `echo "COMMIT=$(git log -1 --format='%h %s' 2>/dev/null)"`,
        ].join(" && ");
        return {
          id: `repo-${i}`,
          command: `su - dev -c '${script.replace(/'/g, "'\\''")}'`,
        };
      }),
    );

    const repoStatuses: GitRepoStatus[] = repos.map((repo, i) => {
      const result = results.find((r) => r.id === `repo-${i}`);
      if (!result) {
        return {
          path: repo.clonePath,
          branch: null,
          dirty: false,
          ahead: 0,
          behind: 0,
          lastCommit: null,
          error: "No result from agent",
        };
      }

      const output = result.stdout.trim();
      if (output === "NOT_GIT" || result.exitCode !== 0) {
        return {
          path: repo.clonePath,
          branch: null,
          dirty: false,
          ahead: 0,
          behind: 0,
          lastCommit: null,
          error:
            output === "NOT_GIT"
              ? "Not a git repository"
              : result.stderr || "Command failed",
        };
      }

      const outputLines = output.split("\n");
      const getValue = (prefix: string): string => {
        const line = outputLines.find((l) => l.startsWith(prefix));
        return line ? line.slice(prefix.length) : "";
      };

      const branch = getValue("BRANCH=");
      const dirty = getValue("DIRTY=");
      const counts = getValue("COUNTS=");
      const commit = getValue("COMMIT=");

      const [ahead, behind] = counts.trim().split(/\s+/).map(Number);

      return {
        path: repo.clonePath,
        branch: branch || null,
        dirty: dirty.length > 0,
        ahead: ahead || 0,
        behind: behind || 0,
        lastCommit: commit || null,
      };
    });

    return { repos: repoStatuses };
  }

  async gitDiffStat(
    sandboxId: string,
    repos: { clonePath: string }[],
  ): Promise<GitDiffResult> {
    if (repos.length === 0) return { repos: [] };

    const { results } = await this.client.batchExec(
      sandboxId,
      repos.map((repo, i) => {
        const repoPath = `/home/dev${repo.clonePath}`;
        const script = [
          `cd "${repoPath}" 2>/dev/null || { echo "NOT_GIT"; exit 0; }`,
          `git rev-parse --git-dir >/dev/null 2>&1 || { echo "NOT_GIT"; exit 0; }`,
          `echo "UNSTAGED"`,
          `git diff --numstat HEAD 2>/dev/null | head -200`,
          `echo "STAGED"`,
          `git diff --numstat --cached HEAD 2>/dev/null | head -200`,
          `echo "UNTRACKED"`,
          `git ls-files --others --exclude-standard 2>/dev/null | head -100`,
        ].join(" && ");
        return {
          id: `diff-${i}`,
          command: `su - dev -c '${script.replace(/'/g, "'\\''")}'`,
        };
      }),
    );

    const diffRepos: GitDiffRepo[] = repos.map((repo, i) => {
      const result = results.find((r) => r.id === `diff-${i}`);
      if (!result) {
        return {
          path: repo.clonePath,
          files: [],
          totalAdded: 0,
          totalRemoved: 0,
          error: "No result from agent",
        };
      }

      const output = result.stdout.trim();
      if (output === "NOT_GIT" || result.exitCode !== 0) {
        return {
          path: repo.clonePath,
          files: [],
          totalAdded: 0,
          totalRemoved: 0,
          error:
            output === "NOT_GIT"
              ? "Not a git repository"
              : result.stderr || "Command failed",
        };
      }

      const files: GitDiffFile[] = [];
      let totalAdded = 0;
      let totalRemoved = 0;

      const lines = output.split("\n");
      let currentSection = "";

      for (const line of lines) {
        if (line === "UNSTAGED" || line === "STAGED" || line === "UNTRACKED") {
          currentSection = line;
          continue;
        }

        if (!line.trim()) continue;

        if (currentSection === "UNTRACKED") {
          // Untracked files: just count as added
          files.push({
            path: line,
            added: 1,
            removed: 0,
          });
          totalAdded += 1;
        } else {
          // Numstat format: added\tremoved\tpath
          const parts = line.split("\t");
          if (parts.length >= 3) {
            const added = parseInt(parts[0] || "0", 10);
            const removed = parseInt(parts[1] || "0", 10);
            const path = parts.slice(2).join("\t");

            files.push({
              path,
              added,
              removed,
            });
            totalAdded += added;
            totalRemoved += removed;
          }
        }
      }

      return {
        path: repo.clonePath,
        files,
        totalAdded,
        totalRemoved,
      };
    });

    return { repos: diffRepos };
  }

  async gitCommit(
    sandboxId: string,
    repoPath: string,
    message: string,
  ): Promise<GitCommitResult> {
    const fullPath = `/home/dev${repoPath}`;
    const escapedMessage = message.replace(/'/g, "'\\''");
    const script = [
      `cd "${fullPath}" 2>/dev/null || { echo "NOT_GIT"; exit 1; }`,
      `git rev-parse --git-dir >/dev/null 2>&1 || { echo "NOT_GIT"; exit 1; }`,
      `git add -A`,
      `git commit -m '${escapedMessage}'`,
      `git rev-parse --short HEAD`,
    ].join(" && ");

    try {
      const result = await this.client.exec(
        sandboxId,
        `su - dev -c '${script.replace(/'/g, "'\\''")}'`,
        { timeout: 30000 },
      );

      if (result.exitCode !== 0) {
        const output = result.stdout.trim();
        return {
          path: repoPath,
          success: false,
          error:
            output === "NOT_GIT"
              ? "Not a git repository"
              : result.stderr || "Commit failed",
        };
      }

      const hash = result.stdout.trim().split("\n").pop() || "";
      return {
        path: repoPath,
        success: true,
        hash,
      };
    } catch (error) {
      return {
        path: repoPath,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async gitPush(sandboxId: string, repoPath: string): Promise<GitPushResult> {
    const fullPath = `/home/dev${repoPath}`;
    const script = [
      `cd "${fullPath}" 2>/dev/null || { echo "NOT_GIT"; exit 1; }`,
      `git rev-parse --git-dir >/dev/null 2>&1 || { echo "NOT_GIT"; exit 1; }`,
      `git push 2>&1 || git push --set-upstream origin $(git branch --show-current) 2>&1`,
    ].join(" && ");

    try {
      const result = await this.client.exec(
        sandboxId,
        `su - dev -c '${script.replace(/'/g, "'\\''")}'`,
        { timeout: 30000 },
      );

      if (result.exitCode !== 0) {
        const output = result.stdout.trim();
        return {
          path: repoPath,
          success: false,
          error:
            output === "NOT_GIT"
              ? "Not a git repository"
              : result.stderr || result.stdout || "Push failed",
        };
      }

      return {
        path: repoPath,
        success: true,
      };
    } catch (error) {
      return {
        path: repoPath,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async resizeStorage(sandboxId: string): Promise<{
    success: boolean;
    disk?: { total: number; used: number; free: number };
    error?: string;
  }> {
    try {
      const result = await this.client.exec(
        sandboxId,
        [
          "test -e /dev/vda || mknod /dev/vda b 254 0",
          "resize2fs /dev/vda",
          "df -B1 / | tail -1",
        ].join(" && "),
        { timeout: 60000 },
      );

      if (result.exitCode !== 0) {
        return { success: false, error: result.stderr };
      }

      const lastLine = result.stdout.split("\n").pop() ?? "";
      const [, total, used, free] = lastLine.split(/\s+/);
      return {
        success: true,
        disk: {
          total: parseInt(total || "0", 10),
          used: parseInt(used || "0", 10),
          free: parseInt(free || "0", 10),
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async getInstalledExtensions(sandboxId: string): Promise<string[]> {
    try {
      const result = await this.client.exec(
        sandboxId,
        "code-server --list-extensions 2>/dev/null || true",
      );
      return result.stdout
        .trim()
        .split("\n")
        .filter((e) => e.length > 0);
    } catch {
      return [];
    }
  }

  async installExtensions(
    sandboxId: string,
    extensions: string[],
  ): Promise<{ extension: string; success: boolean; error?: string }[]> {
    const { results } = await this.client.batchExec(
      sandboxId,
      extensions.map((ext) => ({
        id: ext,
        command: `code-server --install-extension ${ext}`,
        timeout: 120000,
      })),
      { timeout: extensions.length * 120000 + 10000 },
    );

    return results.map((r) => ({
      extension: r.id,
      success: r.exitCode === 0,
      error: r.exitCode !== 0 ? r.stderr || "Install failed" : undefined,
    }));
  }
}
