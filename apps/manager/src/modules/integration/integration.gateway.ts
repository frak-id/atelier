import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import type { SandboxLifecycle } from "../../orchestrators/sandbox-lifecycle.ts";
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
      .map((w) => `- **${w.name}** (id: \`${w.id}\`)`)
      .join("\n");

    const integrationPayload = JSON.stringify({
      source: event.source,
      threadKey: event.threadKey,
      raw: event.raw,
    });

    const masterPrompt = [
      "You are the Atelier bot. Someone mentioned you on an external platform.",
      "You have access to atelier-mcp tools to manage workspaces and tasks.",
      "",
      "Available workspaces:",
      workspaceList || "- (no workspaces configured)",
      "",
      "Based on the conversation context below, decide what to do:",
      "",
      "- If the user is requesting implementation, review, fix, or any coding work:",
      "  1. Pick the most appropriate workspace",
      "  2. Use `create_task` with `autoStart: true` and pass the integration",
      "     metadata below so the task is linked to this conversation",
      "",
      "- If it's a question you can answer without a task:",
      "  1. Respond concisely (the platform will handle delivery)",
      "",
      "**Integration metadata (pass to create_task as-is):**",
      "```json",
      integrationPayload,
      "```",
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

      const { error: promptError } = await client.session.prompt({
        sessionID: session.id,
        parts: [{ type: "text", text: masterPrompt }],
      });

      if (promptError) {
        throw new Error("System sandbox prompt failed");
      }

      log.info(
        { source: event.source, threadKey: event.threadKey },
        "New mention dispatched to system sandbox",
      );
    } finally {
      this.deps.systemSandboxService.release();
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
}
