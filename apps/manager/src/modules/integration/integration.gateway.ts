import {
  createOpencodeClient,
  type Part,
  type ToolPart,
} from "@opencode-ai/sdk/v2";
import type { SandboxLifecycle } from "../../orchestrators/sandbox-lifecycle.ts";
import type { TaskIntegrationMetadata } from "../../schemas/task.ts";
import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import { buildOpenCodeAuthHeaders } from "../../shared/lib/opencode-auth.ts";
import type { SandboxRepository } from "../sandbox/index.ts";
import type { SystemSandboxService } from "../system-sandbox/index.ts";
import type { TaskService } from "../task/index.ts";
import type { WorkspaceService } from "../workspace/index.ts";
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
  workspaceService: WorkspaceService;
}

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

      if (existingTask?.data.sandboxId) {
        await this.handleRemention(event, existingTask, adapter);
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

    const { client } = await this.deps.systemSandboxService.acquire();
    try {
      const { data: session, error: createError } =
        await client.session.create();
      if (createError || !session?.id) {
        throw new Error("Failed to create system sandbox session");
      }

      const { data, error: promptError } = await client.session.prompt({
        sessionID: session.id,
        agent: "dispatcher",
        parts: [{ type: "text", text: dispatcherInput }],
      });

      if (promptError) {
        throw new Error("System sandbox prompt failed");
      }

      const taskId = await this.extractCreatedTaskId(client, session.id);

      if (taskId) {
        log.info(
          { taskId, threadKey: event.threadKey },
          "Task created via system sandbox — injecting metadata",
        );
        await this.attachIntegrationToTask(taskId, event);
      }

      if (data) {
        const textReply = data.parts
          .filter(
            (p): p is Extract<Part, { type: "text" }> => p.type === "text",
          )
          .map((p) => p.text)
          .join("\n")
          .trim();

        if (textReply) {
          log.info(
            { threadKey: event.threadKey, hasTask: !!taskId },
            "Forwarding text response to platform",
          );
          await adapter.postMessage(event, textReply);
        }
      }
    } finally {
      this.deps.systemSandboxService.release();
    }
  }

  private async attachIntegrationToTask(
    taskId: string,
    event: IntegrationEvent,
  ): Promise<void> {
    const raw = event.raw as Record<string, unknown>;
    const metadata: TaskIntegrationMetadata = {
      source: event.source,
      threadKey: event.threadKey,
    };

    if (event.source === "slack") {
      metadata.slack = {
        channel: String(raw.channel ?? ""),
        ts: String(raw.ts ?? ""),
        threadTs: String(raw.threadTs ?? ""),
      };
    } else if (event.source === "github") {
      metadata.github = {
        owner: String(raw.owner ?? ""),
        repo: String(raw.repo ?? ""),
        prNumber: Number(raw.prNumber ?? 0),
      };
    }

    this.deps.taskService.setIntegrationMetadata(taskId, metadata);

    // Start the event bridge for real-time progress
    try {
      const { integrationEventBridge } = await import("../../container.ts");
      await integrationEventBridge.startListening(taskId);
    } catch (error) {
      log.warn(
        { taskId, error },
        "Failed to start event bridge after metadata injection",
      );
    }
  }

  private async handleRemention(
    event: IntegrationEvent,
    task: NonNullable<ReturnType<TaskService["getById"]>>,
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

    const url = `http://${updatedSandbox.runtime.ipAddress}:${config.advanced.vm.opencode.port}`;
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

    try {
      const { integrationEventBridge } = await import("../../container.ts");
      await integrationEventBridge.startListening(task.id);
    } catch (error) {
      log.debug(
        { taskId: task.id, error },
        "Failed to restart event bridge on re-mention",
      );
    }
  }

  private async resolveOrCreateSession(
    client: ReturnType<typeof createOpencodeClient>,
    task: NonNullable<ReturnType<TaskService["getById"]>>,
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
        const toolPart = part as ToolPart;
        if (!toolPart.tool.endsWith("create_task")) continue;
        if (toolPart.state.status !== "completed") continue;

        try {
          const output = JSON.parse(toolPart.state.output);
          if (output?.id && typeof output.id === "string") {
            return output.id;
          }
        } catch {
          log.warn(
            { tool: toolPart.tool },
            "Failed to parse create_task output",
          );
        }
      }
    }

    return undefined;
  }
}
