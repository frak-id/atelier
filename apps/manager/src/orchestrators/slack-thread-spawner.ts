import { DEFAULT_SESSION_TEMPLATES } from "@frak-sandbox/shared/constants";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import type { webApi } from "@slack/bolt";

type WebClient = InstanceType<typeof webApi.WebClient>;

import type { AgentClient } from "../infrastructure/agent/index.ts";
import type { SandboxRepository } from "../modules/sandbox/index.ts";
import type { SessionTemplateService } from "../modules/session-template/index.ts";
import type { SlackThreadService } from "../modules/slack-thread/index.ts";
import type { WorkspaceService } from "../modules/workspace/index.ts";
import type { RepoConfig, SlackThread, Workspace } from "../schemas/index.ts";
import { config } from "../shared/lib/config.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import type { SandboxSpawner } from "./sandbox-spawner.ts";

const log = createChildLogger("slack-thread-spawner");

const AGENT_READY_TIMEOUT = 60000;
const OPENCODE_HEALTH_TIMEOUT = 120000;
const WORKSPACE_DIR = "/home/dev";
const MAX_SLACK_MESSAGE_LENGTH = 300;
const POLL_INTERVAL_MS = 5000;

interface SlackThreadSpawnerDependencies {
  sandboxSpawner: SandboxSpawner;
  sandboxService: SandboxRepository;
  slackThreadService: SlackThreadService;
  workspaceService: WorkspaceService;
  sessionTemplateService: SessionTemplateService;
  agentClient: AgentClient;
}

export class SlackThreadSpawner {
  private readonly activeSubscriptions = new Map<string, AbortController>();
  private webClient: WebClient | null = null;

  constructor(private readonly deps: SlackThreadSpawnerDependencies) {}

  setWebClient(client: WebClient): void {
    this.webClient = client;
  }

  async run(threadId: string): Promise<void> {
    const thread = this.deps.slackThreadService.getById(threadId);
    if (!thread) {
      throw new Error(`SlackThread '${threadId}' not found`);
    }

    if (thread.status !== "spawning") {
      log.warn(
        { threadId, status: thread.status },
        "Thread not in spawning status, skipping",
      );
      return;
    }

    if (thread.sandboxId) {
      log.warn({ threadId }, "Thread already has sandbox, skipping");
      return;
    }

    const workspace = this.deps.workspaceService.getById(thread.workspaceId);
    if (!workspace) {
      throw new Error(`Workspace '${thread.workspaceId}' not found`);
    }

    log.info(
      { threadId, workspaceId: thread.workspaceId },
      "Starting slack thread execution",
    );

    let sandboxId: string | undefined;

    try {
      const sandbox = await this.deps.sandboxSpawner.spawn({
        workspaceId: thread.workspaceId,
        baseImage: workspace.config.baseImage,
        vcpus: workspace.config.vcpus,
        memoryMb: workspace.config.memoryMb,
      });

      sandboxId = sandbox.id;
      const ipAddress = sandbox.runtime.ipAddress;

      log.info(
        { threadId, sandboxId, ip: ipAddress },
        "Sandbox spawned for thread",
      );

      const agentReady = await this.deps.agentClient.waitForAgent(sandbox.id, {
        timeout: AGENT_READY_TIMEOUT,
      });

      if (!agentReady) {
        throw new Error("Agent failed to become ready");
      }

      await this.waitForOpencode(ipAddress);

      const targetRepos = this.getTargetRepos(workspace);
      let branchName: string | undefined;
      let opencodeDirectory: string | undefined;

      if (targetRepos.length === 1 && targetRepos[0]) {
        const repo = targetRepos[0];
        const clonePath = repo.clonePath.startsWith("/")
          ? repo.clonePath
          : `/${repo.clonePath}`;
        opencodeDirectory = `${WORKSPACE_DIR}${clonePath}`;

        branchName = await this.createBranch(
          sandbox.id,
          opencodeDirectory,
          repo.branch,
          threadId,
        );

        if (branchName) {
          log.info({ threadId, branchName }, "Created thread branch");
        }
      }

      this.deps.slackThreadService.attachSandbox(
        threadId,
        sandbox.id,
        branchName,
      );

      const opencodeUrl = `http://${ipAddress}:${config.raw.services.opencode.port}`;
      const sessionTemplateId = this.getSessionTemplateId(workspace);
      const sessionConfig = this.resolveSessionConfig(
        sessionTemplateId,
        workspace.id,
      );

      const sessionResult = await this.createOpencodeSession(
        opencodeUrl,
        `Slack thread ${threadId}`,
        opencodeDirectory,
      );

      if ("error" in sessionResult) {
        throw new Error(`Failed to create session: ${sessionResult.error}`);
      }

      this.deps.slackThreadService.attachSession(
        threadId,
        sessionResult.sessionId,
      );

      const prompt = this.buildPrompt(
        thread,
        workspace,
        targetRepos,
        branchName,
        sessionConfig.promptTemplate,
      );

      const promptResult = await this.sendPrompt(
        opencodeUrl,
        sessionResult.sessionId,
        prompt,
        sessionConfig,
      );

      if ("error" in promptResult) {
        throw new Error(`Failed to send prompt: ${promptResult.error}`);
      }

      this.deps.slackThreadService.markActive(threadId);

      const refreshedThread = this.deps.slackThreadService.getById(threadId);
      if (refreshedThread) {
        this.subscribeToSession(refreshedThread);
      }

      await this.postToSlack(
        thread.channelId,
        thread.threadTs,
        `Sandbox ready. Working on your request...`,
        sandbox.runtime.urls?.opencode,
      );

      log.info({ threadId, sandboxId }, "Slack thread session started");
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      log.error(
        { threadId, sandboxId, error: errorMessage },
        "Slack thread spawn failed",
      );

      if (sandboxId) {
        try {
          const { sandboxDestroyer } = await import("../container.ts");
          await sandboxDestroyer.destroy(sandboxId);
        } catch (cleanupError) {
          log.warn(
            { sandboxId, error: cleanupError },
            "Failed to cleanup thread sandbox",
          );
        }
      }

      this.deps.slackThreadService.markError(threadId, errorMessage);

      await this.postToSlack(
        thread.channelId,
        thread.threadTs,
        `Failed to start sandbox: ${errorMessage}`,
      );

      throw error;
    }
  }

  runInBackground(threadId: string): void {
    setImmediate(() => {
      this.run(threadId).catch((error) => {
        log.error({ threadId, error }, "Background thread spawn failed");
      });
    });
  }

  private subscribeToSession(thread: SlackThread): void {
    const controller = new AbortController();
    this.activeSubscriptions.set(thread.id, controller);

    const sandbox = this.deps.sandboxService.getById(thread.sandboxId!);
    if (!sandbox) return;

    const opcClient = createOpencodeClient({
      baseUrl: `http://${sandbox.runtime.ipAddress}:${config.raw.services.opencode.port}`,
    });

    let lastMessageCount = 0;

    const poll = async () => {
      while (!controller.signal.aborted) {
        try {
          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
          if (controller.signal.aborted) break;

          const { data: messages } = await opcClient.session.messages({
            sessionID: thread.sessionId!,
          });
          if (!messages || messages.length <= lastMessageCount) continue;

          lastMessageCount = messages.length;

          const lastAssistant = [...messages]
            .reverse()
            .find(
              (m) =>
                m.info.role === "assistant" &&
                m.parts?.some((p) => p.type === "text"),
            );

          if (!lastAssistant) continue;

          const textPart = lastAssistant.parts?.find((p) => p.type === "text");
          if (!textPart || textPart.type !== "text") continue;

          const raw = textPart.text ?? "";
          const formatted = this.formatForSlack(raw);

          await this.postToSlack(
            thread.channelId,
            thread.threadTs,
            formatted,
            sandbox.runtime.urls?.opencode,
          );
        } catch (error) {
          if (controller.signal.aborted) break;
          log.warn({ threadId: thread.id, error }, "Session poll error");
        }
      }
    };

    poll().catch((error) => {
      log.warn({ threadId: thread.id, error }, "Session subscription ended");
    });
  }

  async rehydrateActiveThreads(): Promise<void> {
    const activeThreads = this.deps.slackThreadService.getActive();
    let count = 0;

    for (const thread of activeThreads) {
      if (thread.sessionId && thread.sandboxId) {
        this.subscribeToSession(thread);
        count++;
      }
    }

    log.info({ count }, "Rehydrated active thread subscriptions");
  }

  cleanup(threadId: string): void {
    const controller = this.activeSubscriptions.get(threadId);
    if (controller) {
      controller.abort();
      this.activeSubscriptions.delete(threadId);
    }
  }

  private formatForSlack(text: string): string {
    let formatted = text
      .replace(/\*\*(.+?)\*\*/g, "*$1*")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

    if (formatted.length > MAX_SLACK_MESSAGE_LENGTH) {
      formatted = `${formatted.slice(0, MAX_SLACK_MESSAGE_LENGTH)}...`;
    }

    return formatted;
  }

  private async postToSlack(
    channelId: string,
    threadTs: string,
    text: string,
    opencodeUrl?: string,
  ): Promise<void> {
    if (!this.webClient) {
      log.warn("No Slack WebClient set, skipping message post");
      return;
    }

    try {
      const blocks: Array<any> = [
        { type: "section", text: { type: "mrkdwn", text } },
      ];

      if (opencodeUrl) {
        blocks.push({
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "View in OpenCode" },
              url: opencodeUrl,
            },
          ],
        });
      }

      await this.webClient.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text,
        blocks,
      });
    } catch (error) {
      log.warn({ channelId, threadTs, error }, "Failed to post to Slack");
    }
  }

  private getTargetRepos(workspace: Workspace): RepoConfig[] {
    return workspace.config.repos ?? [];
  }

  private async createBranch(
    sandboxId: string,
    repoPath: string,
    baseBranch: string,
    threadId: string,
  ): Promise<string | undefined> {
    const baseBranchName = `thread/${threadId}`;

    const gitExec = (cmd: string, timeout = 30000) =>
      this.deps.agentClient.exec(
        sandboxId,
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

    log.warn({ threadId }, "Exhausted branch name attempts");
    return undefined;
  }

  private getSessionTemplateId(_workspace: Workspace): string {
    return "implement";
  }

  private resolveSessionConfig(
    sessionTemplateId: string,
    workspaceId: string,
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
      const variant = defaultTemplate.variants[0];
      if (!variant) return {};
      return {
        model: variant.model,
        variant: variant.variant,
        agent: variant.agent,
        promptTemplate: defaultTemplate.promptTemplate,
      };
    }

    const variantIdx = template.defaultVariantIndex ?? 0;
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

  private buildPrompt(
    thread: SlackThread,
    workspace: Workspace,
    targetRepos: RepoConfig[],
    branchName: string | undefined,
    promptTemplate?: string,
  ): string {
    if (promptTemplate) {
      const variables = {
        task: {
          title: `Slack thread ${thread.id}`,
          description: thread.initialMessage,
          context: undefined,
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
          id: thread.sandboxId ?? "undefined",
          ip: "unknown",
          url: "unknown",
        },
      };

      return this.deps.sessionTemplateService.renderPromptTemplate(
        {
          id: "",
          name: "",
          category: "primary",
          variants: [],
          promptTemplate,
        },
        variables,
      );
    }

    let prompt = `# Slack Thread Request\n\n`;

    const firstRepo = targetRepos[0];
    if (branchName && targetRepos.length === 1 && firstRepo) {
      prompt += `**Working branch:** \`${branchName}\` (based on \`${firstRepo.branch}\`)\n`;
      prompt += `**Directory:** \`${WORKSPACE_DIR}${firstRepo.clonePath}\`\n\n`;
    }

    prompt += thread.initialMessage;

    return prompt;
  }

  private async waitForOpencode(ipAddress: string): Promise<void> {
    const startTime = Date.now();
    const url = `http://${ipAddress}:${config.raw.services.opencode.port}`;

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

  private async createOpencodeSession(
    baseUrl: string,
    title: string,
    directory?: string,
  ): Promise<{ sessionId: string } | { error: string }> {
    try {
      const client = createOpencodeClient({ baseUrl });
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
    sessionConfig?: SessionConfig,
  ): Promise<{ success: true } | { error: string }> {
    try {
      const client = createOpencodeClient({ baseUrl });
      const result = await client.session.promptAsync({
        sessionID: sessionId,
        parts: [{ type: "text", text: message }],
        ...(sessionConfig?.model && { model: sessionConfig.model }),
        ...(sessionConfig?.variant && { variant: sessionConfig.variant }),
        ...(sessionConfig?.agent && { agent: sessionConfig.agent }),
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

interface SessionConfig {
  model?: { providerID: string; modelID: string };
  variant?: string;
  agent?: string;
  promptTemplate?: string;
}
