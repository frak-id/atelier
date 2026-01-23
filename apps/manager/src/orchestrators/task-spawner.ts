import { EFFORT_CONFIG, type TaskEffort } from "@frak-sandbox/shared/constants";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import type { AgentClient } from "../infrastructure/agent/index.ts";
import type { SandboxService } from "../modules/sandbox/index.ts";
import type { TaskService } from "../modules/task/index.ts";
import type { WorkspaceService } from "../modules/workspace/index.ts";
import type { RepoConfig, Task, Workspace } from "../schemas/index.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import type { SandboxSpawner } from "./sandbox-spawner.ts";
import type { SessionMonitor } from "./session-monitor.ts";

const log = createChildLogger("task-spawner");

const AGENT_READY_TIMEOUT = 60000;
const OPENCODE_HEALTH_TIMEOUT = 120000;
const OPENCODE_PORT = 3000;
const WORKSPACE_DIR = "/home/dev";

interface TaskSpawnerDependencies {
  sandboxSpawner: SandboxSpawner;
  sandboxService: SandboxService;
  taskService: TaskService;
  workspaceService: WorkspaceService;
  agentClient: AgentClient;
  sessionMonitor: SessionMonitor;
}

export class TaskSpawner {
  constructor(private readonly deps: TaskSpawnerDependencies) {}

  async run(taskId: string): Promise<void> {
    const task = this.deps.taskService.getById(taskId);
    if (!task) {
      throw new Error(`Task '${taskId}' not found`);
    }

    if (task.status !== "queue") {
      log.warn(
        { taskId, status: task.status },
        "Task not in queue status, skipping",
      );
      return;
    }

    const workspace = this.deps.workspaceService.getById(task.workspaceId);
    if (!workspace) {
      throw new Error(`Workspace '${task.workspaceId}' not found`);
    }

    log.info(
      { taskId, title: task.title, workspaceId: task.workspaceId },
      "Starting task execution",
    );

    let sandboxId: string | undefined;

    try {
      const sandbox = await this.deps.sandboxSpawner.spawn({
        workspaceId: task.workspaceId,
        baseImage: workspace.config.baseImage,
        vcpus: workspace.config.vcpus,
        memoryMb: workspace.config.memoryMb,
      });

      sandboxId = sandbox.id;
      const ipAddress = sandbox.runtime.ipAddress;
      const opencodeUrl = `http://${ipAddress}:${OPENCODE_PORT}`;

      log.info(
        { taskId, sandboxId, ip: ipAddress },
        "Sandbox spawned for task",
      );

      const agentReady = await this.deps.agentClient.waitForAgent(ipAddress, {
        timeout: AGENT_READY_TIMEOUT,
      });

      if (!agentReady) {
        throw new Error("Agent failed to become ready");
      }

      await this.waitForOpencode(ipAddress);

      const targetRepos = this.getTargetRepos(task, workspace);
      let branchName: string | undefined;
      let opencodeDirectory: string | undefined;

      if (targetRepos.length === 1 && targetRepos[0]) {
        const repo = targetRepos[0];
        const clonePath = repo.clonePath.startsWith("/")
          ? repo.clonePath
          : `/${repo.clonePath}`;
        opencodeDirectory = `${WORKSPACE_DIR}${clonePath}`;

        const baseBranch = task.data.baseBranch || repo.branch;
        branchName = await this.createBranch(
          ipAddress,
          opencodeDirectory,
          baseBranch,
          task.id,
        );

        if (branchName) {
          log.info({ taskId, branchName, baseBranch }, "Created task branch");
        }
      }

      const sessionResult = await this.createSession(
        opencodeUrl,
        task.title,
        opencodeDirectory,
      );
      if ("error" in sessionResult) {
        throw new Error(
          `Failed to create OpenCode session: ${sessionResult.error}`,
        );
      }

      const prompt = this.buildPrompt(task, targetRepos, branchName);
      const promptResult = await this.sendPrompt(
        opencodeUrl,
        sessionResult.sessionId,
        prompt,
        task.data.effort,
      );
      if ("error" in promptResult) {
        throw new Error(`Failed to send prompt: ${promptResult.error}`);
      }

      this.deps.taskService.moveToInProgress(
        taskId,
        sandbox.id,
        sessionResult.sessionId,
        branchName,
      );

      log.info(
        { taskId, sandboxId, sessionId: sessionResult.sessionId },
        "Task moved to in_progress",
      );

      this.deps.sessionMonitor.startMonitoring(
        taskId,
        sessionResult.sessionId,
        ipAddress,
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      log.error(
        { taskId, sandboxId, error: errorMessage },
        "Task spawn failed",
      );

      if (sandboxId) {
        try {
          const { sandboxDestroyer } = await import("../container.ts");
          await sandboxDestroyer.destroy(sandboxId);
        } catch (cleanupError) {
          log.warn(
            { sandboxId, error: cleanupError },
            "Failed to cleanup task sandbox",
          );
        }
      }

      this.deps.taskService.resetToDraft(taskId);
      throw error;
    }
  }

  runInBackground(taskId: string): void {
    setImmediate(() => {
      this.run(taskId).catch((error) => {
        log.error({ taskId, error }, "Background task spawn failed");
      });
    });
  }

  private getTargetRepos(task: Task, workspace: Workspace): RepoConfig[] {
    const allRepos = workspace.config.repos;
    if (allRepos.length === 0) return [];

    const indices = task.data.targetRepoIndices;
    if (!indices || indices.length === 0) {
      return allRepos;
    }

    return indices
      .filter((i) => i >= 0 && i < allRepos.length)
      .map((i) => allRepos[i])
      .filter((repo): repo is RepoConfig => repo !== undefined);
  }

  private async createBranch(
    ipAddress: string,
    repoPath: string,
    baseBranch: string,
    taskId: string,
  ): Promise<string | undefined> {
    const baseBranchName = `task/${taskId}`;

    // Helper to run git commands as dev user (repo owner)
    const gitExec = (cmd: string, timeout = 30000) =>
      this.deps.agentClient.exec(
        ipAddress,
        `su - dev -c 'cd ${repoPath} && ${cmd}'`,
        { timeout },
      );

    for (let attempt = 0; attempt < 10; attempt++) {
      const branchName =
        attempt === 0 ? baseBranchName : `${baseBranchName}_v${attempt + 1}`;

      const checkoutBase = await gitExec(
        `git fetch origin && git checkout ${baseBranch} && git pull origin ${baseBranch}`,
      );

      if (checkoutBase.exitCode !== 0) {
        log.warn(
          { repoPath, baseBranch, stderr: checkoutBase.stderr },
          "Failed to checkout base branch",
        );
        return undefined;
      }

      const createBranch = await gitExec(
        `git checkout -b ${branchName}`,
        10000,
      );

      if (createBranch.exitCode === 0) {
        return branchName;
      }

      if (!createBranch.stderr.includes("already exists")) {
        log.warn(
          { branchName, stderr: createBranch.stderr },
          "Failed to create branch",
        );
        return undefined;
      }

      log.debug({ branchName }, "Branch exists, trying next suffix");
    }

    log.warn({ taskId }, "Exhausted branch name attempts");
    return undefined;
  }

  private buildPrompt(
    task: Task,
    targetRepos: RepoConfig[],
    branchName?: string,
  ): string {
    let prompt = `# Task: ${task.title}\n\n`;

    const firstRepo = targetRepos[0];
    if (branchName && targetRepos.length === 1 && firstRepo) {
      const baseBranch = task.data.baseBranch || firstRepo.branch;
      prompt += `**Working branch:** \`${branchName}\` (based on \`${baseBranch}\`)\n`;
      prompt += `**Directory:** \`${WORKSPACE_DIR}${firstRepo.clonePath}\`\n\n`;
    } else if (targetRepos.length > 1) {
      prompt += "**Working directories:**\n";
      for (const repo of targetRepos) {
        prompt += `- \`${WORKSPACE_DIR}${repo.clonePath}\`\n`;
      }
      prompt += "\n";
    }

    prompt += task.data.description;

    if (task.data.context) {
      prompt += `\n\n## Additional Context\n${task.data.context}`;
    }

    return prompt;
  }

  private async waitForOpencode(ipAddress: string): Promise<void> {
    const startTime = Date.now();
    const url = `http://${ipAddress}:${OPENCODE_PORT}`;

    while (Date.now() - startTime < OPENCODE_HEALTH_TIMEOUT) {
      try {
        const client = createOpencodeClient({ baseUrl: url });
        const { data } = await client.global.health();
        if (data?.healthy) {
          log.info({ ip: ipAddress }, "OpenCode server is healthy");
          return;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    throw new Error("OpenCode server did not become healthy within timeout");
  }

  private async createSession(
    baseUrl: string,
    title: string,
    directory?: string,
  ): Promise<{ sessionId: string } | { error: string }> {
    try {
      const client = createOpencodeClient({ baseUrl });
      const { data, error } = await client.session.create({
        title: `Task: ${title}`,
        ...(directory && { directory }),
      });
      if (error || !data?.id) {
        return { error: "Failed to create session" };
      }
      return { sessionId: data.id };
    } catch (e) {
      return { error: e instanceof Error ? e.message : "Unknown error" };
    }
  }

  private async sendPrompt(
    baseUrl: string,
    sessionId: string,
    message: string,
    effort?: TaskEffort,
  ): Promise<{ success: true } | { error: string }> {
    try {
      const client = createOpencodeClient({ baseUrl });
      const config = effort ? EFFORT_CONFIG[effort] : undefined;

      const result = await client.session.promptAsync({
        sessionID: sessionId,
        parts: [{ type: "text", text: message }],
        ...(config && {
          model: config.model,
          variant: config.variant,
          agent: config.agent,
        }),
      });
      if (result.error) {
        return { error: "Failed to send message" };
      }
      return { success: true };
    } catch (e) {
      return { error: e instanceof Error ? e.message : "Unknown error" };
    }
  }
}
