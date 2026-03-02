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

  async resizeStorage(_sandboxId: string): Promise<{
    success: boolean;
    disk?: { total: number; used: number; free: number };
    error?: string;
  }> {
    // TODO: Implement K8s PVC resize when storage augmentation is needed.
    return {
      success: false,
      error: "Storage resize is not yet supported in K8s mode",
    };
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
  ): Promise<
    {
      extension: string;
      success: boolean;
      error?: string;
    }[]
  > {
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
