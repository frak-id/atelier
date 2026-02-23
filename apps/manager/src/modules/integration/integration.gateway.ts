import {
  createOpencodeClient,
  type Part,
  type ToolPart,
} from "@opencode-ai/sdk/v2";
import type { AgentClient } from "../../infrastructure/agent/index.ts";
import { CaddyService } from "../../infrastructure/proxy/index.ts";
import type { SandboxLifecycle } from "../../orchestrators/sandbox-lifecycle.ts";
import type { TaskSpawner } from "../../orchestrators/task-spawner.ts";
import type { Task } from "../../schemas/index.ts";
import type { TaskIntegrationMetadata } from "../../schemas/task.ts";
import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import { buildOpenCodeAuthHeaders } from "../../shared/lib/opencode-auth.ts";
import type { SandboxRepository } from "../sandbox/index.ts";
import type { SessionTemplateService } from "../session-template/index.ts";
import type {
  SystemAiService,
  SystemSandboxService,
} from "../system-sandbox/index.ts";
import type { TaskService } from "../task/index.ts";
import type { WorkspaceService } from "../workspace/index.ts";
import type {
  IntegrationAdapter,
  IntegrationEvent,
  IntegrationSource,
} from "./integration.types.ts";
import {
  type IntegrationCommand,
  parseMention,
} from "./integration-commands.ts";

const log = createChildLogger("integration-gateway");

const WORKING_EMOJI = "hourglass_flowing_sand";

interface IntegrationGatewayDependencies {
  taskService: TaskService;
  sandboxService: SandboxRepository;
  sandboxLifecycle: SandboxLifecycle;
  systemSandboxService: SystemSandboxService;
  workspaceService: WorkspaceService;
  systemAiService: SystemAiService;
  taskSpawner: TaskSpawner;
  agentClient: AgentClient;
  sessionTemplateService: SessionTemplateService;
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
      const parsed = parseMention(event.text);
      const existingTask = this.deps.taskService.findByIntegrationKey(
        event.source,
        event.threadKey,
      );

      switch (parsed.type) {
        case "help":
          await this.handleHelp(event, existingTask, adapter);
          break;
        case "status":
          await this.handleStatus(event, existingTask, adapter);
          break;
        case "new":
          await this.handleNewMention({ ...event, text: parsed.text }, adapter);
          break;
        case "dev":
          await this.handleDevCommand(event, existingTask, parsed, adapter);
          break;
        case "cancel":
          await this.handleCancel(event, existingTask, adapter);
          break;
        case "restart":
          await this.handleRestart(event, existingTask, parsed.text, adapter);
          break;
        case "add":
        case "review":
        case "security":
        case "simplify":
          await this.handleSessionCommand(event, existingTask, parsed, adapter);
          break;
        default:
          if (existingTask?.data.sandboxId) {
            await this.handleRemention(event, existingTask, adapter);
          } else {
            await this.handleNewMention(event, adapter);
          }
          break;
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

  private async handleSessionCommand(
    event: IntegrationEvent,
    task: Task | undefined,
    parsed: Extract<
      IntegrationCommand,
      { type: "add" | "review" | "security" | "simplify" }
    >,
    adapter: IntegrationAdapter,
  ): Promise<void> {
    if (!task?.data.sandboxId) {
      await adapter.postMessage(
        event,
        "No active task in this thread. Send a message to start one.",
      );
      return;
    }

    const sandbox = this.deps.sandboxService.getById(task.data.sandboxId);
    if (!sandbox) {
      await adapter.postMessage(
        event,
        "Sandbox not found. Send a new message to create a fresh task.",
      );
      return;
    }

    if (sandbox.status === "stopped") {
      try {
        await this.deps.sandboxLifecycle.start(sandbox.id);
      } catch {
        await adapter.postMessage(event, "Failed to resume sandbox.");
        return;
      }
    } else if (sandbox.status !== "running") {
      await adapter.postMessage(
        event,
        `Sandbox is ${sandbox.status}. Cannot add session.`,
      );
      return;
    }

    const runningSandbox = this.deps.sandboxService.getById(
      task.data.sandboxId,
    );
    if (!runningSandbox?.runtime?.ipAddress) {
      await adapter.postMessage(event, "Sandbox is not running.");
      return;
    }

    const templateMap: Record<typeof parsed.type, string> = {
      add: "implement",
      review: "best-practices",
      security: "security-review",
      simplify: "simplification",
    };

    const templateId = templateMap[parsed.type];
    let latestSessionId: string | undefined;

    if (parsed.type === "add") {
      if (!parsed.text.trim()) {
        await adapter.postMessage(
          event,
          "Please provide a description: /add describe what you want",
        );
        return;
      }

      const sessionConfig =
        this.deps.sessionTemplateService.resolveSessionConfig(
          templateId,
          task.workspaceId,
        );

      const opcClient = createOpencodeClient({
        baseUrl: `http://${runningSandbox.runtime.ipAddress}:${config.advanced.vm.opencode.port}`,
        headers: buildOpenCodeAuthHeaders(
          runningSandbox.runtime.opencodePassword,
        ),
      });

      const { data: session, error: createError } =
        await opcClient.session.create({
          title: task.title,
        });
      if (createError || !session?.id) {
        throw new Error("Failed to create session");
      }

      const { error: promptError } = await opcClient.session.promptAsync({
        sessionID: session.id,
        parts: [{ type: "text", text: parsed.text }],
        ...(sessionConfig?.model && { model: sessionConfig.model }),
        ...(sessionConfig?.variant && { variant: sessionConfig.variant }),
        ...(sessionConfig?.agent && { agent: sessionConfig.agent }),
      });
      if (promptError) {
        throw new Error("Failed to start add session prompt");
      }

      this.deps.taskService.addSession(task.id, session.id, templateId);
      latestSessionId = session.id;
    } else {
      await this.deps.taskSpawner.addSession(task.id, templateId);
      const updatedTask = this.deps.taskService.getById(task.id);
      const sessions = updatedTask?.data.sessions ?? [];
      latestSessionId = sessions[sessions.length - 1]?.id;
    }

    if (latestSessionId && task.data.integration) {
      this.deps.taskService.setIntegrationSessionId(task.id, latestSessionId);
    }

    try {
      const { integrationEventBridge } = await import("../../container.ts");
      await integrationEventBridge.startListening(task.id);
    } catch (error) {
      log.debug(
        { taskId: task.id, error },
        "Failed to restart event bridge after session command",
      );
    }

    const friendlyName: Record<typeof parsed.type, string> = {
      add: "Implementation",
      review: "Best Practices Review",
      security: "Security Review",
      simplify: "Simplification",
    };
    await adapter.postMessage(
      event,
      `Started *${friendlyName[parsed.type]}* session.`,
    );
  }

  private async handleDevCommand(
    event: IntegrationEvent,
    task: Task | undefined,
    parsed: Extract<IntegrationCommand, { type: "dev" }>,
    adapter: IntegrationAdapter,
  ): Promise<void> {
    if (!task?.data.sandboxId) {
      await adapter.postMessage(event, "No active task in this thread.");
      return;
    }

    const sandbox = this.deps.sandboxService.getById(task.data.sandboxId);
    if (!sandbox || sandbox.status !== "running") {
      await adapter.postMessage(event, "Sandbox is not running.");
      return;
    }

    const workspace = task.workspaceId
      ? this.deps.workspaceService.getById(task.workspaceId)
      : undefined;
    const devCommands = workspace?.config.devCommands ?? [];

    const resolveDevCommand = (name?: string) =>
      name
        ? devCommands.find((command) => command.name === name)
        : devCommands[0];

    switch (parsed.action) {
      case "start": {
        const devCommand = resolveDevCommand(parsed.name);
        if (!devCommand) {
          const available = devCommands
            .map((command) => command.name)
            .join(", ");
          await adapter.postMessage(
            event,
            `Dev command not found. Available: ${available || "none"}`,
          );
          return;
        }

        try {
          const devCommandWithEnv = {
            ...devCommand,
            env: {
              ...devCommand.env,
              ATELIER_SANDBOX_ID: sandbox.id,
            },
          };
          await this.deps.agentClient.devStart(
            sandbox.id,
            devCommand.name,
            devCommandWithEnv,
          );

          if (devCommand.port && sandbox.runtime?.ipAddress) {
            const urls = await CaddyService.registerDevRoute(
              sandbox.id,
              sandbox.runtime.ipAddress,
              devCommand.name,
              devCommand.port,
              devCommand.isDefault ?? false,
              devCommand.extraPorts,
            );

            await adapter.postMessage(
              event,
              `Started \`${devCommand.name}\` -> ${urls.namedUrl}${urls.defaultUrl ? ` (also ${urls.defaultUrl})` : ""}`,
            );
          } else {
            await adapter.postMessage(
              event,
              `Started \`${devCommand.name}\` (no port configured)`,
            );
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          await adapter.postMessage(
            event,
            `Failed to start \`${devCommand.name}\`: ${msg}`,
          );
        }
        return;
      }
      case "stop": {
        const devCommand = resolveDevCommand(parsed.name);
        if (!devCommand) {
          await adapter.postMessage(event, "Dev command not found.");
          return;
        }

        try {
          await this.deps.agentClient.devStop(sandbox.id, devCommand.name);
          if (devCommand.port) {
            await CaddyService.removeDevRoute(
              sandbox.id,
              devCommand.name,
              devCommand.isDefault ?? false,
              devCommand.extraPorts,
            );
          }
          await adapter.postMessage(event, `Stopped \`${devCommand.name}\``);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          await adapter.postMessage(event, `Failed to stop: ${msg}`);
        }
        return;
      }
      case "logs": {
        const devCommand = resolveDevCommand(parsed.name);
        if (!devCommand) {
          await adapter.postMessage(event, "Dev command not found.");
          return;
        }

        try {
          const logs = await this.deps.agentClient.devLogs(
            sandbox.id,
            devCommand.name,
            0,
            3000,
          );
          const content = logs.content || "(no output)";
          await adapter.postMessage(
            event,
            `\`\`\`\n${content.slice(-2000)}\n\`\`\``,
          );
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          await adapter.postMessage(event, `Failed to get logs: ${msg}`);
        }
        return;
      }
      case "url": {
        const devCommand = parsed.name
          ? devCommands.find((command) => command.name === parsed.name)
          : devCommands.find((command) => command.port);

        if (!devCommand?.port) {
          await adapter.postMessage(event, "No dev command with a port found.");
          return;
        }

        const namedUrl = `https://dev-${devCommand.name}-${sandbox.id}.${config.domain.baseDomain}`;
        const defaultUrl = devCommand.isDefault
          ? `https://dev-${sandbox.id}.${config.domain.baseDomain}`
          : undefined;

        await adapter.postMessage(
          event,
          `${devCommand.name}: ${namedUrl}${defaultUrl ? `\nDefault: ${defaultUrl}` : ""}`,
        );
        return;
      }
      default: {
        try {
          const runtimeStatus = await this.deps.agentClient.devList(sandbox.id);
          const lines = devCommands.map((command) => {
            const runtime = runtimeStatus.commands?.find(
              (item) => item.name === command.name,
            );
            const status =
              runtime?.status === "running" ? "running" : "stopped";
            const url =
              status === "running" && command.port
                ? `https://dev-${command.name}-${sandbox.id}.${config.domain.baseDomain}`
                : "";
            return `- \`${command.name}\` - ${status}${url ? ` -> ${url}` : ""}`;
          });
          await adapter.postMessage(
            event,
            lines.length > 0 ? lines.join("\n") : "No dev commands configured.",
          );
        } catch {
          const lines = devCommands.map(
            (command) => `- \`${command.name}\` - \`${command.command}\``,
          );
          await adapter.postMessage(
            event,
            lines.join("\n") || "No dev commands configured.",
          );
        }
      }
    }
  }

  private async handleCancel(
    event: IntegrationEvent,
    task: Task | undefined,
    adapter: IntegrationAdapter,
  ): Promise<void> {
    if (!task?.data.sandboxId || !task.data.integration?.sessionId) {
      await adapter.postMessage(event, "No active session to cancel.");
      return;
    }

    const sandbox = this.deps.sandboxService.getById(task.data.sandboxId);
    if (!sandbox?.runtime?.ipAddress || sandbox.status !== "running") {
      await adapter.postMessage(event, "Sandbox is not running.");
      return;
    }

    try {
      const opcClient = createOpencodeClient({
        baseUrl: `http://${sandbox.runtime.ipAddress}:${config.advanced.vm.opencode.port}`,
        headers: buildOpenCodeAuthHeaders(sandbox.runtime.opencodePassword),
      });
      await opcClient.session.abort({
        sessionID: task.data.integration.sessionId,
      });
      await adapter.postMessage(event, "Session cancelled.");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await adapter.postMessage(event, `Failed to cancel: ${msg}`);
    }
  }

  private async handleRestart(
    event: IntegrationEvent,
    task: Task | undefined,
    text: string,
    adapter: IntegrationAdapter,
  ): Promise<void> {
    if (!task?.data.sandboxId) {
      await adapter.postMessage(event, "No active task to restart.");
      return;
    }

    const sandbox = this.deps.sandboxService.getById(task.data.sandboxId);
    if (!sandbox?.runtime?.ipAddress || sandbox.status !== "running") {
      await adapter.postMessage(event, "Sandbox is not running.");
      return;
    }

    const opcClient = createOpencodeClient({
      baseUrl: `http://${sandbox.runtime.ipAddress}:${config.advanced.vm.opencode.port}`,
      headers: buildOpenCodeAuthHeaders(sandbox.runtime.opencodePassword),
    });

    if (task.data.integration?.sessionId) {
      try {
        await opcClient.session.abort({
          sessionID: task.data.integration.sessionId,
        });
      } catch {}
    }

    const { data: session } = await opcClient.session.create({
      title: task.title,
    });
    if (!session?.id) {
      throw new Error("Failed to create replacement session");
    }

    this.deps.taskService.setIntegrationSessionId(task.id, session.id);

    const prompt = text || task.data.description;
    await opcClient.session.promptAsync({
      sessionID: session.id,
      parts: [{ type: "text", text: prompt }],
    });

    try {
      const { integrationEventBridge } = await import("../../container.ts");
      await integrationEventBridge.startListening(task.id);
    } catch (error) {
      log.debug(
        { taskId: task.id, error },
        "Failed to restart event bridge after restart command",
      );
    }

    await adapter.postMessage(event, "Session restarted.");
  }

  private async handleStatus(
    event: IntegrationEvent,
    task: Task | undefined,
    adapter: IntegrationAdapter,
  ): Promise<void> {
    if (!task) {
      await adapter.postMessage(event, "No task in this thread.");
      return;
    }

    const sandbox = task.data.sandboxId
      ? this.deps.sandboxService.getById(task.data.sandboxId)
      : undefined;

    const lines: string[] = [];
    lines.push(`*Task:* ${task.title} (\`${task.status}\`)`);
    lines.push(
      `*Sandbox:* ${sandbox ? `\`${sandbox.id}\` - ${sandbox.status}` : "none"}`,
    );

    if (sandbox?.runtime?.ipAddress && sandbox.status === "running") {
      try {
        const opcClient = createOpencodeClient({
          baseUrl: `http://${sandbox.runtime.ipAddress}:${config.advanced.vm.opencode.port}`,
          headers: buildOpenCodeAuthHeaders(sandbox.runtime.opencodePassword),
        });
        const { data: statuses } = await opcClient.session.status();
        const statusMap = (statuses ?? {}) as Record<string, { type: string }>;
        const sessionEntries = Object.entries(statusMap);
        if (sessionEntries.length > 0) {
          const summary = sessionEntries
            .map(([id, status]) => `\`${id.slice(0, 8)}\` ${status.type}`)
            .join(", ");
          lines.push(`*Sessions:* ${summary}`);
        }
      } catch {}
    }

    const sessions = task.data.sessions ?? [];
    if (sessions.length > 0) {
      lines.push(`*Total sessions:* ${sessions.length}`);
    }

    await adapter.postMessage(event, lines.join("\n"));
  }

  private async handleHelp(
    event: IntegrationEvent,
    task: Task | undefined,
    adapter: IntegrationAdapter,
  ): Promise<void> {
    const lines: string[] = [];

    if (task?.data.sandboxId) {
      const workspace = this.deps.workspaceService.getById(task.workspaceId);
      lines.push(`*Active task:* ${task.title}`);
      if (workspace) {
        lines.push(`*Workspace:* ${workspace.name}`);

        const devCommands = workspace.config.devCommands ?? [];
        if (devCommands.length > 0) {
          lines.push(
            `*Dev commands:* ${devCommands.map((command) => `\`${command.name}\``).join(", ")}`,
          );
        }

        const { templates } =
          this.deps.sessionTemplateService.getMergedTemplates(workspace.id);
        if (templates.length > 0) {
          lines.push(
            `*Session templates:* ${templates.map((template) => `\`${template.id}\` (${template.name})`).join(", ")}`,
          );
        }
      }
      lines.push("");
    }

    lines.push("*Commands:*");
    lines.push("- _(message)_ - Continue current task");
    lines.push("- `/new (prompt)` - Start a new task");
    lines.push("- `/add (prompt)` - New coding session in current sandbox");
    lines.push("- `/review` - Best practices review session");
    lines.push("- `/security` - Security review session");
    lines.push("- `/simplify` - Simplification session");
    lines.push(
      "- `/dev start|stop|logs|url|list [name]` - Manage dev commands",
    );
    lines.push("- `/cancel` - Cancel current session");
    lines.push("- `/restart [prompt]` - Restart with fresh session");
    lines.push("- `/status` - Show task and sandbox status");
    lines.push("- `/help` - This message");

    await adapter.postMessage(event, lines.join("\n"));
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

      const dispatcherModel =
        this.deps.systemAiService.resolveModel("dispatcher");
      const { data, error: promptError } = await client.session.prompt({
        sessionID: session.id,
        agent: "dispatcher",
        ...(dispatcherModel && { model: dispatcherModel }),
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
