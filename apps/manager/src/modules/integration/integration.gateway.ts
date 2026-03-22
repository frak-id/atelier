import { createOpencodeClient, type Part } from "@opencode-ai/sdk/v2";
import type { SandboxLifecycle } from "../../orchestrators/sandbox-lifecycle.ts";
import type { TaskSpawner } from "../../orchestrators/task-spawner.ts";
import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import { buildOpenCodeAuthHeaders } from "../../shared/lib/opencode-auth.ts";
import type { SandboxRepository } from "../sandbox/index.ts";
import type {
  SystemAiService,
  SystemSandboxEventListener,
  SystemSandboxService,
} from "../system-sandbox/index.ts";
import type { TaskService } from "../task/index.ts";
import type { WorkspaceService } from "../workspace/index.ts";
import type { GitHubIntegrationContext } from "./adapters/github.adapter.ts";
import type {
  IntegrationAdapter,
  IntegrationEvent,
  IntegrationSource,
} from "./integration.types.ts";

const log = createChildLogger("integration-gateway");

const WORKING_EMOJI = "hourglass_flowing_sand";

interface IntegrationGatewayDependencies {
  taskService: TaskService;
  sandboxService: SandboxRepository;
  sandboxLifecycle: SandboxLifecycle;
  systemSandboxService: SystemSandboxService;
  systemSandboxEventListener: SystemSandboxEventListener;
  workspaceService: WorkspaceService;
  systemAiService: SystemAiService;
  taskSpawner: TaskSpawner;
}

type ExistingTask = NonNullable<ReturnType<TaskService["getById"]>>;

export class IntegrationGateway {
  private adapters = new Map<IntegrationSource, IntegrationAdapter>();

  constructor(private readonly deps: IntegrationGatewayDependencies) {}

  registerAdapter(adapter: IntegrationAdapter): void {
    this.adapters.set(adapter.source, adapter);
    log.info({ source: adapter.source }, "Integration adapter registered");
  }

  getAdapter(source: IntegrationSource): IntegrationAdapter | undefined {
    return this.adapters.get(source);
  }

  async handleEvent(event: IntegrationEvent): Promise<void> {
    const adapter = this.adapters.get(event.source);
    if (!adapter) {
      log.error({ source: event.source }, "No adapter registered");
      return;
    }

    log.info(
      { source: event.source, threadKey: event.threadKey, user: event.user },
      "Handling integration event",
    );

    await adapter.addReaction(event, WORKING_EMOJI);

    try {
      const existingTask = this.deps.taskService.findByIntegrationKey(
        event.source,
        event.threadKey,
      );

      if (existingTask?.data.sandboxId && !event.isDirectMessage) {
        await this.handleRemention(event, existingTask, adapter);
      } else if (event.source === "github") {
        await this.handleGitHubNewMention(event, adapter);
      } else {
        await this.handleNewMention(event, adapter);
      }
    } catch (error) {
      log.error(
        { source: event.source, threadKey: event.threadKey, error },
        "Integration event handling failed",
      );
      try {
        await adapter.postMessage(
          event,
          "⚠️ Something went wrong processing your request. Please try again.",
        );
      } catch {
        log.warn("Failed to post error message back to platform");
      }
    } finally {
      await adapter.removeReaction(event, WORKING_EMOJI);
    }
  }

  private async handleNewMention(
    event: IntegrationEvent,
    adapter: IntegrationAdapter,
  ): Promise<void> {
    log.info(
      { source: event.source, threadKey: event.threadKey },
      "New mention — dispatching to system sandbox",
    );

    const context = await adapter.extractContext(event);
    const contextMarkdown = adapter.formatContextForPrompt(context);

    const workspaces = this.deps.workspaceService.getAll();
    const workspaceList = workspaces
      .map(
        (w) =>
          `- **${w.name}** (id: \`${w.id}\`)${w.config.description ? ` — ${w.config.description}` : ""}`,
      )
      .join("\n");

    const dispatcherInput = [
      "Available workspaces:",
      workspaceList || "- (no workspaces configured)",
      "",
      "---",
      "",
      contextMarkdown,
    ].join("\n");

    await this.dispatchToSystemSandbox(dispatcherInput, event, adapter);
  }

  private async handleGitHubNewMention(
    event: IntegrationEvent,
    adapter: IntegrationAdapter,
  ): Promise<void> {
    const raw = event.raw as Record<string, unknown>;
    const owner = String(raw.owner ?? "");
    const repo = String(raw.repo ?? "");

    log.info(
      { owner, repo, threadKey: event.threadKey },
      "GitHub mention — direct workspace match",
    );

    const remoteUrl = `https://github.com/${owner}/${repo}`;
    const match = this.deps.workspaceService.matchByRemoteUrl(remoteUrl);

    if (!match) {
      await adapter.postMessage(
        event,
        `No workspace configured for \`${owner}/${repo}\`. ` +
          "Create a workspace with this repository first.",
      );
      return;
    }

    const context = await adapter.extractContext(event);
    const description = adapter.formatContextForPrompt(context);

    const ghContext = context as GitHubIntegrationContext;
    const baseBranch = ghContext.github?.baseBranch ?? match.matchedRepo.branch;

    const title = this.deps.systemAiService.fallbackTitle(event.text);
    const task = this.deps.taskService.create({
      workspaceId: match.workspace.id,
      description,
      title,
      baseBranch,
    });

    this.deps.systemAiService.generateTitleInBackground(
      event.text,
      (generated) => {
        this.deps.taskService.updateTitle(task.id, generated);
        this.deps.taskSpawner
          .updateSessionTitles(task.id, generated)
          .catch(() => {});
      },
    );

    try {
      await this.deps.taskService.startTask(task.id);
      this.deps.taskSpawner.runInBackground(task.id);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await adapter.postMessage(event, `Failed to start task: ${msg}`);
      return;
    }

    await this.attachIntegrationToTask(task.id, event);

    log.info(
      {
        taskId: task.id,
        workspaceId: match.workspace.id,
        threadKey: event.threadKey,
      },
      "GitHub task created via direct dispatch",
    );
  }

  /**
   * Dispatch a prompt to the system sandbox and collect results.
   *
   * Registers SSE event callbacks BEFORE firing promptAsync to
   * avoid a race where the task-created or session-idle event
   * arrives before the callback is in place.
   *
   * The sandbox slot is released immediately after promptAsync
   * so concurrent dispatches are not serialized. The opencode
   * client remains usable after release because the sandbox
   * will not be disposed for IDLE_TIMEOUT_MS (30 min).
   */
  private async dispatchToSystemSandbox(
    prompt: string,
    event: IntegrationEvent,
    adapter: IntegrationAdapter,
  ): Promise<void> {
    const { client } = await this.deps.systemSandboxService.acquire();
    let released = false;
    let sessionId: string | undefined;

    try {
      const { data: session, error: createError } =
        await client.session.create();
      if (createError || !session?.id) {
        throw new Error("Failed to create system sandbox session");
      }

      sessionId = session.id;

      try {
        // Register callbacks BEFORE promptAsync to avoid
        // missing fast SSE events (race condition fix).
        const taskPromise = this.deps.systemSandboxEventListener.waitForTask(
          session.id,
        );
        const idlePromise = this.deps.systemSandboxEventListener.waitForIdle(
          session.id,
        );

        const dispatcherModel =
          this.deps.systemAiService.resolveModel("dispatcher");
        const { error: promptError } = await client.session.promptAsync({
          sessionID: session.id,
          agent: "dispatcher",
          ...(dispatcherModel && {
            model: dispatcherModel,
          }),
          parts: [{ type: "text", text: prompt }],
        });

        if (promptError) {
          throw new Error("System sandbox prompt failed");
        }

        this.deps.systemSandboxService.release();
        released = true;

        let taskId: string | undefined;

        try {
          taskId = await taskPromise;
        } catch (error) {
          log.warn(
            {
              threadKey: event.threadKey,
              sessionId: session.id,
              error,
            },
            "Failed waiting for dispatcher task event",
          );
        }

        if (taskId) {
          log.info(
            { taskId, threadKey: event.threadKey },
            "Task created via system sandbox",
          );
          await this.attachIntegrationToTask(taskId, event);
        }

        try {
          await idlePromise;
        } catch (error) {
          log.warn(
            {
              threadKey: event.threadKey,
              sessionId: session.id,
              error,
            },
            "Failed waiting for dispatcher idle event",
          );
        }

        if (!taskId) {
          taskId = await this.extractCreatedTaskId(client, session.id);

          if (taskId) {
            log.info(
              { taskId, threadKey: event.threadKey },
              "Task found via fallback message inspection",
            );
            await this.attachIntegrationToTask(taskId, event);
          }
        }

        await this.postDispatcherReply(
          client,
          session.id,
          event,
          adapter,
          taskId,
        );
      } finally {
        if (sessionId) {
          await client.session.delete({ sessionID: sessionId }).catch(() => {});
        }
      }
    } finally {
      if (!released) {
        this.deps.systemSandboxService.release();
      }
    }
  }

  private async postDispatcherReply(
    client: ReturnType<typeof createOpencodeClient>,
    sessionId: string,
    event: IntegrationEvent,
    adapter: IntegrationAdapter,
    taskId: string | undefined,
  ): Promise<void> {
    const { data: messages } = await client.session.messages({
      sessionID: sessionId,
    });

    const textReply = (messages ?? [])
      .filter((message) => message.info.role === "assistant")
      .flatMap((message) => message.parts)
      .filter(
        (part): part is Extract<Part, { type: "text" }> => part.type === "text",
      )
      .map((part) => part.text)
      .join("\n")
      .trim();

    if (textReply) {
      log.info(
        {
          threadKey: event.threadKey,
          hasTask: !!taskId,
        },
        "Forwarding text response to platform",
      );
      await adapter.postMessage(event, textReply);
    }
  }

  private async attachIntegrationToTask(
    taskId: string,
    event: IntegrationEvent,
  ): Promise<void> {
    const adapter = this.adapters.get(event.source);
    if (!adapter) return;

    const metadata = adapter.buildTaskMetadata(event);
    this.deps.taskService.setIntegrationMetadata(taskId, metadata);

    await this.startEventBridge(taskId);
  }

  private async handleRemention(
    event: IntegrationEvent,
    task: ExistingTask,
    adapter: IntegrationAdapter,
  ): Promise<void> {
    const sandboxId = task.data.sandboxId;
    if (!sandboxId) return;

    log.info(
      {
        source: event.source,
        threadKey: event.threadKey,
        taskId: task.id,
        sandboxId,
      },
      "Re-mention — routing to existing task sandbox",
    );

    const sandbox = this.deps.sandboxService.getById(sandboxId);
    if (!sandbox) {
      log.warn({ sandboxId }, "Task sandbox not found, treating as new");
      await this.handleNewMention(event, adapter);
      return;
    }

    if (sandbox.status === "stopped") {
      log.info({ sandboxId }, "Resuming stopped task sandbox");
      try {
        await this.deps.sandboxLifecycle.start(sandboxId);
      } catch (error) {
        log.error({ sandboxId, error }, "Failed to resume sandbox");
        await adapter.postMessage(
          event,
          "⚠️ Failed to resume the sandbox for this task. Creating a new one.",
        );
        await this.handleNewMention(event, adapter);
        return;
      }
    } else if (sandbox.status !== "running") {
      log.warn(
        { sandboxId, status: sandbox.status },
        "Sandbox in unexpected state, treating as new",
      );
      await this.handleNewMention(event, adapter);
      return;
    }

    const updatedSandbox = this.deps.sandboxService.getById(sandboxId);
    if (!updatedSandbox?.runtime?.ipAddress) {
      log.error({ sandboxId }, "Sandbox has no IP after resume");
      await this.handleNewMention(event, adapter);
      return;
    }

    const context = await adapter.extractContext(event);
    const contextMarkdown = adapter.formatContextForPrompt(context);

    const followUpPrompt = [
      "Follow-up request on your current task.",
      "A new message was posted in the conversation thread that triggered this task.",
      "",
      "---",
      "",
      contextMarkdown,
    ].join("\n");

    const url = `http://${updatedSandbox.runtime.ipAddress}:${config.ports.opencode}`;
    const opcClient = createOpencodeClient({
      baseUrl: url,
      headers: buildOpenCodeAuthHeaders(
        updatedSandbox.runtime.opencodePassword,
      ),
    });

    const sessionId = await this.resolveOrCreateSession(opcClient, task);

    const { error: promptError } = await opcClient.session.promptAsync({
      sessionID: sessionId,
      parts: [{ type: "text", text: followUpPrompt }],
    });

    if (promptError) {
      throw new Error("Task sandbox prompt failed");
    }

    log.info(
      { taskId: task.id, sandboxId, sessionId },
      "Re-mention dispatched to task sandbox",
    );

    await this.startEventBridge(task.id);
  }

  private async resolveOrCreateSession(
    client: ReturnType<typeof createOpencodeClient>,
    task: ExistingTask,
  ): Promise<string> {
    const existingSessionId = task.data.integration?.sessionId;

    if (existingSessionId) {
      try {
        const { data } = await client.session.get({
          sessionID: existingSessionId,
        });
        if (data?.id) {
          log.info(
            { taskId: task.id, sessionId: existingSessionId },
            "Reusing existing integration session",
          );
          return existingSessionId;
        }
      } catch {
        log.info(
          { taskId: task.id, sessionId: existingSessionId },
          "Stored session not found, creating new one",
        );
      }
    }

    const { data: session, error } = await client.session.create();
    if (error || !session?.id) {
      throw new Error("Failed to create session on task sandbox");
    }

    this.deps.taskService.setIntegrationSessionId(task.id, session.id);

    log.info(
      { taskId: task.id, sessionId: session.id },
      "Created new integration session",
    );
    return session.id;
  }

  private async extractCreatedTaskId(
    client: ReturnType<typeof createOpencodeClient>,
    sessionId: string,
  ): Promise<string | undefined> {
    const { data: messages } = await client.session.messages({
      sessionID: sessionId,
    });
    if (!messages) return undefined;

    for (const msg of messages) {
      for (const part of msg.parts) {
        if (part.type !== "tool") continue;
        if (!part.tool.endsWith("create_task")) continue;
        if (part.state.status !== "completed") continue;

        try {
          const output = JSON.parse(part.state.output);
          if (output?.id && typeof output.id === "string") {
            return output.id;
          }
        } catch {
          log.warn({ tool: part.tool }, "Failed to parse create_task output");
        }
      }
    }

    return undefined;
  }

  private async startEventBridge(taskId: string): Promise<void> {
    try {
      const { integrationEventBridge } = await import("../../container.ts");
      await integrationEventBridge.startListening(taskId);
    } catch (error) {
      log.debug({ taskId, error }, "Failed to start event bridge");
    }
  }
}
