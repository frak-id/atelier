import type { AgentClient } from "./agent.client.ts";
import type {
  AgentHealth,
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
    const serviceNames = ["code-server", "opencode", "sshd", "ttyd"];
    const { results } = await this.client.batchExec(
      sandboxId,
      serviceNames.map((name) => ({
        id: name,
        command: `pgrep -f "${name}" 2>/dev/null || true`,
      })),
    );

    const services: ServiceStatus[] = results.map((r) => {
      const pids = r.stdout.trim().split("\n").filter(Boolean);
      return {
        name: r.id,
        running: pids.length > 0,
        pid: pids[0] ? parseInt(pids[0], 10) : undefined,
      };
    });

    return { services };
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
