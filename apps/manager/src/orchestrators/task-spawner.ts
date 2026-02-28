import { DEFAULT_SESSION_TEMPLATES, VM } from "@frak/atelier-shared/constants";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import type { AgentClient } from "../infrastructure/agent/index.ts";
import type { SandboxRepository } from "../modules/sandbox/index.ts";
import type { SessionTemplateService } from "../modules/session-template/index.ts";
import type { TaskService } from "../modules/task/index.ts";
import type { WorkspaceService } from "../modules/workspace/index.ts";
import type {
  RepoConfig,
  SessionTemplateVariables,
  Task,
  Workspace,
} from "../schemas/index.ts";
import { config } from "../shared/lib/config.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import { buildOpenCodeAuthHeaders } from "../shared/lib/opencode-auth.ts";
import { waitForOpencode } from "./sandbox-provisioning.ts";
import type { SandboxSpawner } from "./sandbox-spawner.ts";

const log = createChildLogger("task-spawner");

const AGENT_READY_TIMEOUT = 60000;

const WORKSPACE_DIR = VM.HOME;

interface TaskSpawnerDependencies {
  sandboxSpawner: SandboxSpawner;
  sandboxService: SandboxRepository;
  taskService: TaskService;
  workspaceService: WorkspaceService;
  sessionTemplateService: SessionTemplateService;
  agentClient: AgentClient;
}

interface SessionConfig {
  model?: { providerID: string; modelID: string };
  variant?: string;
  agent?: string;
  promptTemplate?: string;
}

export class TaskSpawner {
  constructor(private readonly deps: TaskSpawnerDependencies) {}

  async run(taskId: string): Promise<void> {
    const task = this.deps.taskService.getById(taskId);
    if (!task) {
      throw new Error(`Task '${taskId}' not found`);
    }

    if (task.status !== "active") {
      log.warn(
        { taskId, status: task.status },
        "Task not in active status, skipping",
      );
      return;
    }

    if (task.data.sandboxId) {
      log.warn({ taskId }, "Task already has sandbox, skipping initial spawn");
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

      log.info(
        { taskId, sandboxId, ip: ipAddress },
        "Sandbox spawned for task",
      );

      const agentReady = await this.deps.agentClient.waitForAgent(sandbox.id, {
        timeout: AGENT_READY_TIMEOUT,
      });

      if (!agentReady) {
        throw new Error("Agent failed to become ready");
      }

      await waitForOpencode(ipAddress, sandbox.runtime.opencodePassword);

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
          sandbox.id,
          opencodeDirectory,
          baseBranch,
          task.id,
        );

        if (branchName) {
          log.info({ taskId, branchName, baseBranch }, "Created task branch");
        }
      }

      this.deps.taskService.attachSandbox(taskId, sandbox.id, branchName);

      const sessionTemplateId = this.getFirstSessionTemplateId(task, workspace);
      await this.spawnSession(
        taskId,
        sessionTemplateId,
        ipAddress,
        opencodeDirectory,
        sandbox.runtime.opencodePassword,
      );

      log.info({ taskId, sandboxId }, "Task initial session started");
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

  async updateSessionTitles(taskId: string, title: string): Promise<void> {
    const task = this.deps.taskService.getById(taskId);
    if (!task?.data.sandboxId || !task.data.sessions?.length) {
      return;
    }

    const sandbox = this.deps.sandboxService.getById(task.data.sandboxId);
    if (!sandbox?.runtime?.ipAddress) return;

    const url = `http://${sandbox.runtime.ipAddress}:${config.advanced.vm.opencode.port}`;
    const client = createOpencodeClient({
      baseUrl: url,
      headers: buildOpenCodeAuthHeaders(sandbox.runtime.opencodePassword),
    });

    await Promise.allSettled(
      task.data.sessions.map((session) =>
        client.session.update({ sessionID: session.id, title }).catch((err) => {
          log.warn(
            {
              taskId,
              sessionId: session.id,
              error: String(err),
            },
            "Failed to update OpenCode session title",
          );
        }),
      ),
    );

    log.info(
      { taskId, title, sessionCount: task.data.sessions.length },
      "OpenCode session titles updated",
    );
  }

  async addSession(taskId: string, sessionTemplateId: string): Promise<void> {
    const task = this.deps.taskService.getById(taskId);
    if (!task) {
      throw new Error(`Task '${taskId}' not found`);
    }

    if (task.status !== "active") {
      throw new Error("Task must be active to spawn sessions");
    }

    if (!task.data.sandboxId) {
      throw new Error("Task has no sandbox - start task first");
    }

    const sandbox = this.deps.sandboxService.getById(task.data.sandboxId);
    if (!sandbox?.runtime?.ipAddress) {
      throw new Error("Sandbox not running");
    }

    const workspace = this.deps.workspaceService.getById(task.workspaceId);
    if (!workspace) {
      throw new Error(`Workspace '${task.workspaceId}' not found`);
    }

    const targetRepos = this.getTargetRepos(task, workspace);
    let opencodeDirectory: string | undefined;
    if (targetRepos.length === 1 && targetRepos[0]) {
      const repo = targetRepos[0];
      const clonePath = repo.clonePath.startsWith("/")
        ? repo.clonePath
        : `/${repo.clonePath}`;
      opencodeDirectory = `${WORKSPACE_DIR}${clonePath}`;
    }

    await this.spawnSession(
      taskId,
      sessionTemplateId,
      sandbox.runtime.ipAddress,
      opencodeDirectory,
      sandbox.runtime.opencodePassword,
    );
  }

  addSessionInBackground(taskId: string, sessionTemplateId: string): void {
    setImmediate(() => {
      this.addSession(taskId, sessionTemplateId).catch((error) => {
        log.error(
          { taskId, sessionTemplateId, error },
          "Background session spawn failed",
        );
      });
    });
  }

  private async spawnSession(
    taskId: string,
    sessionTemplateId: string,
    ipAddress: string,
    opencodeDirectory?: string,
    password?: string,
  ): Promise<void> {
    const task = this.deps.taskService.getById(taskId);
    if (!task) {
      throw new Error(`Task '${taskId}' not found`);
    }

    const workspace = this.deps.workspaceService.getById(task.workspaceId);
    if (!workspace) {
      throw new Error(`Workspace '${task.workspaceId}' not found`);
    }

    const opencodeUrl = `http://${ipAddress}:${config.advanced.vm.opencode.port}`;
    const sessionConfig = this.resolveSessionConfig(
      sessionTemplateId,
      workspace.id,
      task.data.variantIndex,
    );

    const sessionResult = await this.createOpencodeSession(
      opencodeUrl,
      task.title,
      opencodeDirectory,
      password,
    );

    if ("error" in sessionResult) {
      throw new Error(`Failed to create session: ${sessionResult.error}`);
    }

    const { session } = this.deps.taskService.addSession(
      taskId,
      sessionResult.sessionId,
      sessionTemplateId,
    );

    const prompt = this.buildPrompt(
      task,
      workspace,
      this.getTargetRepos(task, workspace),
      task.data.branchName,
      task.data.sandboxId,
      ipAddress,
      sessionConfig.promptTemplate,
    );

    const promptResult = await this.sendPrompt(
      opencodeUrl,
      session.id,
      prompt,
      sessionConfig,
      password,
    );

    if ("error" in promptResult) {
      throw new Error(`Failed to send prompt: ${promptResult.error}`);
    }

    log.info(
      { taskId, sessionId: session.id, templateId: sessionTemplateId },
      "Session spawned",
    );
  }

  private getFirstSessionTemplateId(task: Task, workspace: Workspace): string {
    const workflowId = task.data.workflowId ?? "implement";
    const workflow = this.deps.sessionTemplateService.getTemplateById(
      workflowId,
      workspace.id,
    );

    if (workflow?.variants?.[0]) {
      return workflowId;
    }

    return "implement";
  }

  private resolveSessionConfig(
    sessionTemplateId: string,
    workspaceId: string,
    taskVariantIndex?: number,
  ): SessionConfig {
    const template = this.deps.sessionTemplateService.getTemplateById(
      sessionTemplateId,
      workspaceId,
    );

    if (!template) {
      const defaultTemplate = DEFAULT_SESSION_TEMPLATES[0];
      if (!defaultTemplate?.variants?.[0]) {
        return {};
      }
      const variantIdx = taskVariantIndex ?? 0;
      const variant =
        defaultTemplate.variants[variantIdx] ?? defaultTemplate.variants[0];
      if (!variant) return {};
      return {
        model: variant.model,
        variant: variant.variant,
        agent: variant.agent,
        promptTemplate: defaultTemplate.promptTemplate,
      };
    }

    const variantIdx = taskVariantIndex ?? template.defaultVariantIndex ?? 0;
    const variant = template.variants[variantIdx] ?? template.variants[0];

    return variant
      ? {
          model: variant.model,
          variant: variant.variant,
          agent: variant.agent,
          promptTemplate: template.promptTemplate,
        }
      : { promptTemplate: template.promptTemplate };
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
    sandboxId: string,
    repoPath: string,
    baseBranch: string,
    taskId: string,
  ): Promise<string | undefined> {
    const baseBranchName = `task/${taskId}`;

    const gitExec = (cmd: string, timeout = 30000) =>
      this.deps.agentClient.exec(sandboxId, cmd, {
        timeout,
        user: "dev",
        workdir: repoPath,
      });

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
    workspace: Workspace,
    targetRepos: RepoConfig[],
    branchName: string | undefined,
    sandboxId: string | undefined,
    ipAddress: string,
    promptTemplate?: string,
  ): string {
    if (promptTemplate) {
      const variables: SessionTemplateVariables = {
        task: {
          description: task.data.description,
          branch: branchName,
        },
        workspace: {
          name: workspace.name,
          reposName: targetRepos.map((r) => {
            if ("url" in r) return r.url.split("/").pop() ?? r.url;
            return r.repo;
          }),
        },
        sandbox: {
          id: sandboxId ?? "undefined",
          ip: ipAddress,
          url: `http://${ipAddress}:${config.advanced.vm.opencode.port}`,
        },
      };

      return this.deps.sessionTemplateService.renderPromptTemplate(
        { id: "", name: "", category: "primary", variants: [], promptTemplate },
        variables,
      );
    }

    let prompt = "";

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

    return prompt;
  }

  private async createOpencodeSession(
    baseUrl: string,
    title: string,
    directory?: string,
    password?: string,
  ): Promise<{ sessionId: string } | { error: string }> {
    try {
      const client = createOpencodeClient({
        baseUrl,
        headers: buildOpenCodeAuthHeaders(password),
      });
      const { data, error } = await client.session.create({
        title,
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
    config?: SessionConfig,
    password?: string,
  ): Promise<{ success: true } | { error: string }> {
    try {
      const client = createOpencodeClient({
        baseUrl,
        headers: buildOpenCodeAuthHeaders(password),
      });

      const result = await client.session.promptAsync({
        sessionID: sessionId,
        parts: [{ type: "text", text: message }],
        ...(config?.model && { model: config.model }),
        ...(config?.variant && { variant: config.variant }),
        ...(config?.agent && { agent: config.agent }),
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
