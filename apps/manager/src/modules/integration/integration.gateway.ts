import { createOpencodeClient, type Part } from "@opencode-ai/sdk/v2";
import type { AgentClient } from "../../infrastructure/agent/index.ts";
import {
  buildDefaultDevIngress,
  buildDevCommandIngress,
  kubeClient,
} from "../../infrastructure/kubernetes/index.ts";
import type { SandboxLifecycle } from "../../orchestrators/sandbox-lifecycle.ts";
import type { TaskSpawner } from "../../orchestrators/task-spawner.ts";
import type { Task } from "../../schemas/index.ts";
import type { TaskIntegrationMetadata } from "../../schemas/task.ts";
import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import { buildOpenCodeAuthHeaders } from "../../shared/lib/opencode-auth.ts";
import {
  openOpencodeSession,
  sendPromptAndVerify,
  startOpencodeSession,
} from "../../shared/lib/opencode-session.ts";
import type { SandboxRepository } from "../sandbox/index.ts";
import type { SessionTemplateService } from "../session-template/index.ts";
import type {
  SystemAiService,
  SystemSandboxEventListener,
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
  systemSandboxEventListener: SystemSandboxEventListener;
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
          // DMs are fire-and-forget — no thread continuation,
          // always treat as a fresh mention.
          if (existingTask?.data.sandboxId && !event.isDirectMessage) {
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
        baseUrl: `http://${runningSandbox.runtime.ipAddress}:${config.ports.opencode}`,
        headers: buildOpenCodeAuthHeaders(
          runningSandbox.runtime.opencodePassword,
        ),
      });

      const session = await startOpencodeSession(opcClient, {
        title: task.title,
        prompt: parsed.text,
        model: sessionConfig?.model,
        variant: sessionConfig?.variant,
        agent: sessionConfig?.agent,
      });

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
            const ingressOpts = {
              ingressClassName: config.kubernetes.ingressClassName || undefined,
              tlsSecretName: "atelier-sandbox-wildcard-tls",
            };

            await kubeClient.createResource(
              buildDevCommandIngress(
                sandbox.id,
                devCommand.name,
                devCommand.port,
                config.domain.dashboard,
                ingressOpts,
              ),
            );

            if (devCommand.isDefault) {
              await kubeClient.createResource(
                buildDefaultDevIngress(
                  sandbox.id,
                  devCommand.port,
                  config.domain.dashboard,
                  ingressOpts,
                ),
              );
            }

            for (const ep of devCommand.extraPorts ?? []) {
              await kubeClient.createResource(
                buildDevCommandIngress(
                  sandbox.id,
                  `${devCommand.name}-${ep.alias}`,
                  ep.port,
                  config.domain.dashboard,
                  ingressOpts,
                ),
              );
            }

            const urls = {
              namedUrl: `https://dev-${devCommand.name}-${sandbox.id}.${config.domain.dashboard}`,
              defaultUrl: devCommand.isDefault
                ? `https://dev-${sandbox.id}.${config.domain.dashboard}`
                : undefined,
            };

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
            await kubeClient.deleteResource(
              "ingresses",
              `dev-${devCommand.name}-${sandbox.id}`,
            );

            if (devCommand.isDefault) {
              kubeClient
                .deleteResource("ingresses", `dev-default-${sandbox.id}`)
                .catch(() => {});
            }

            for (const ep of devCommand.extraPorts ?? []) {
              kubeClient
                .deleteResource(
                  "ingresses",
                  `dev-${devCommand.name}-${ep.alias}-${sandbox.id}`,
                )
                .catch(() => {});
            }
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

        const namedUrl = `https://dev-${devCommand.name}-${sandbox.id}.${config.domain.dashboard}`;
        const defaultUrl = devCommand.isDefault
          ? `https://dev-${sandbox.id}.${config.domain.dashboard}`
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
                ? `https://dev-${command.name}-${sandbox.id}.${config.domain.dashboard}`
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
        baseUrl: `http://${sandbox.runtime.ipAddress}:${config.ports.opencode}`,
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
      baseUrl: `http://${sandbox.runtime.ipAddress}:${config.ports.opencode}`,
      headers: buildOpenCodeAuthHeaders(sandbox.runtime.opencodePassword),
    });

    if (task.data.integration?.sessionId) {
      try {
        await opcClient.session.abort({
          sessionID: task.data.integration.sessionId,
        });
      } catch {}
    }

    const session = await startOpencodeSession(opcClient, {
      title: task.title,
      prompt: text || task.data.description,
    });

    this.deps.taskService.setIntegrationSessionId(task.id, session.id);

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
          baseUrl: `http://${sandbox.runtime.ipAddress}:${config.ports.opencode}`,
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

    await this.dispatchToSystemSandbox(dispatcherInput, event, adapter);
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
   *
   * NOTE: A future improvement would track idle based on
   * session status (all sessions idle → start countdown with a
   * shorter timeout) rather than a fixed timer after release.
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
      const session = await openOpencodeSession(client);
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

        try {
          await sendPromptAndVerify(client, {
            sessionID: session.id,
            agent: "dispatcher",
            ...(dispatcherModel && { model: dispatcherModel }),
            parts: [{ type: "text", text: prompt }],
          });
        } catch (error) {
          throw new Error(
            `System sandbox prompt failed: ${error instanceof Error ? error.message : String(error)}`,
          );
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
    const raw = event.raw as Record<string, unknown>;
    const metadata: TaskIntegrationMetadata = {
      source: event.source,
      externalId: event.threadKey,
    };

    if (event.source === "slack") {
      const channel = String(raw.channel ?? "");
      const threadTs = String(raw.threadTs ?? "");
      const teamId = String(raw.teamId ?? "");
      metadata.slack = {
        channel,
        ts: String(raw.ts ?? ""),
        threadTs,
        teamId: teamId || undefined,
      };
      if (teamId && channel && threadTs) {
        const tsForUrl = threadTs.replace(".", "");
        metadata.externalUrl = `https://app.slack.com/client/${teamId}/${channel}/thread/${channel}-${tsForUrl}`;
      }
    } else if (event.source === "github") {
      const owner = String(raw.owner ?? "");
      const repo = String(raw.repo ?? "");
      const prNumber = Number(raw.prNumber ?? 0);
      metadata.github = {
        owner,
        repo,
        prNumber,
      };
      if (owner && repo && prNumber) {
        metadata.externalUrl = `https://github.com/${owner}/${repo}/pull/${prNumber}`;
      }
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

    const url = `http://${updatedSandbox.runtime.ipAddress}:${config.ports.opencode}`;
    const opcClient = createOpencodeClient({
      baseUrl: url,
      headers: buildOpenCodeAuthHeaders(
        updatedSandbox.runtime.opencodePassword,
      ),
    });

    const sessionId = await this.resolveOrCreateSession(opcClient, task);

    try {
      await sendPromptAndVerify(opcClient, {
        sessionID: sessionId,
        parts: [{ type: "text", text: followUpPrompt }],
      });
    } catch (error) {
      throw new Error(
        `Task sandbox prompt failed: ${error instanceof Error ? error.message : String(error)}`,
      );
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

    const session = await openOpencodeSession(client);

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
}
