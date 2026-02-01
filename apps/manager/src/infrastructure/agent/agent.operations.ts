import type { AgentClient } from "./agent.client.ts";
import type {
  GitCommitResult,
  GitDiffResult,
  GitPushResult,
  GitStatus,
  ServiceStatus,
} from "./agent.types.ts";

export class AgentOperations {
  constructor(private readonly client: AgentClient) {}

  async services(sandboxId: string): Promise<{ services: ServiceStatus[] }> {
    const result = await this.client.serviceList(sandboxId);
    return {
      services: result.services.map((s) => ({
        ...s,
        pid: s.pid ?? undefined,
        port: s.port ?? undefined,
        startedAt: s.startedAt || undefined,
        exitCode: s.exitCode ?? undefined,
        logFile: s.logFile ?? undefined,
      })),
    };
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
    return this.client.gitStatus(sandboxId, repos);
  }

  async gitDiffStat(
    sandboxId: string,
    repos: { clonePath: string }[],
  ): Promise<GitDiffResult> {
    return this.client.gitDiff(sandboxId, repos);
  }

  async gitCommit(
    sandboxId: string,
    repoPath: string,
    message: string,
  ): Promise<GitCommitResult> {
    return this.client.gitCommit(sandboxId, repoPath, message);
  }

  async gitPush(sandboxId: string, repoPath: string): Promise<GitPushResult> {
    return this.client.gitPush(sandboxId, repoPath);
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
