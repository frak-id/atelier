import type { Event as OpencodeEvent } from "@opencode-ai/sdk/v2";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2";
import { config, dashboardUrl } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import { buildOpenCodeAuthHeaders } from "../../shared/lib/opencode-auth.ts";
import type { SandboxRepository } from "../sandbox/index.ts";
import type { TaskService } from "../task/index.ts";
import type { IntegrationGateway } from "./integration.gateway.ts";
import type {
  AttentionItem,
  IntegrationAdapter,
  IntegrationEvent,
  IntegrationSource,
  ProgressState,
  TodoItem,
} from "./integration.types.ts";

const log = createChildLogger("integration-event-bridge");

const REACTION_THINKING = "brain";
const REACTION_ATTENTION = "warning";

const UPDATE_DEBOUNCE_MS = 2_000;
const SSE_MAX_RETRY = 10;
const SSE_RETRY_DELAY = 3_000;
const SSE_MAX_RETRY_DELAY = 30_000;

interface TaskListenerState {
  taskId: string;
  abortController: AbortController;
  opcClient: OpencodeClient;
  event: IntegrationEvent;
  adapter: IntegrationAdapter;
  progressMessageId?: string;
  startedAt: number;
  wasBusy: boolean;
  activeReactions: Set<string>;
  updateTimer?: ReturnType<typeof setTimeout>;
}

interface IntegrationEventBridgeDependencies {
  taskService: TaskService;
  sandboxService: SandboxRepository;
  integrationGateway: IntegrationGateway;
}

export class IntegrationEventBridge {
  private listeners = new Map<string, TaskListenerState>();

  constructor(private readonly deps: IntegrationEventBridgeDependencies) {}

  async startListening(taskId: string): Promise<void> {
    if (this.listeners.has(taskId)) {
      log.debug({ taskId }, "Bridge already listening, skipping");
      return;
    }

    const task = this.deps.taskService.getById(taskId);
    if (!task?.data.integration || !task.data.sandboxId) {
      log.warn(
        {
          taskId,
          hasIntegration: !!task?.data.integration,
          hasSandbox: !!task?.data.sandboxId,
        },
        "Cannot start bridge — missing integration or sandbox",
      );
      return;
    }

    const sandbox = this.deps.sandboxService.getById(task.data.sandboxId);
    if (!sandbox?.runtime?.ipAddress) {
      log.warn(
        { taskId, sandboxId: task.data.sandboxId },
        "Cannot start bridge — sandbox has no IP",
      );
      return;
    }

    const adapter = this.deps.integrationGateway.getAdapter(
      task.data.integration.source as IntegrationSource,
    );
    if (!adapter) {
      log.warn(
        { taskId, source: task.data.integration.source },
        "Cannot start bridge — no adapter for source",
      );
      return;
    }

    const event = this.buildEventFromMetadata(task.data.integration);
    const opcClient = createOpencodeClient({
      baseUrl: `http://${sandbox.runtime.ipAddress}:${config.advanced.vm.opencode.port}`,
      headers: buildOpenCodeAuthHeaders(sandbox.runtime.opencodePassword),
    });

    const state: TaskListenerState = {
      taskId,
      abortController: new AbortController(),
      opcClient,
      event,
      adapter,
      startedAt: Date.now(),
      wasBusy: false,
      activeReactions: new Set(),
    };

    this.listeners.set(taskId, state);

    const progressState = await this.computeProgressState(state);
    if (adapter.postProgressMessage) {
      try {
        state.progressMessageId = await adapter.postProgressMessage(
          event,
          progressState,
        );
      } catch (error) {
        log.debug({ taskId, error }, "Failed to post initial progress");
      }
    }

    log.info({ taskId }, "Started event bridge listener");
    this.subscribe(state);
  }

  stopListening(taskId: string): void {
    const state = this.listeners.get(taskId);
    if (!state) return;

    state.abortController.abort();
    if (state.updateTimer) clearTimeout(state.updateTimer);
    this.listeners.delete(taskId);
    log.info({ taskId }, "Stopped event bridge listener");
  }

  stopAll(): void {
    for (const taskId of [...this.listeners.keys()]) {
      this.stopListening(taskId);
    }
  }

  private buildEventFromMetadata(
    integration: NonNullable<
      ReturnType<TaskService["getById"]>
    >["data"]["integration"],
  ): IntegrationEvent {
    if (!integration) throw new Error("No integration metadata");

    let raw: unknown = {};
    if (integration.slack) {
      raw = {
        channel: integration.slack.channel,
        ts: integration.slack.ts,
        threadTs: integration.slack.threadTs,
      };
    } else if (integration.github) {
      raw = integration.github;
    }

    return {
      source: integration.source as IntegrationSource,
      threadKey: integration.threadKey,
      user: "system",
      text: "",
      raw,
    };
  }

  private subscribe(state: TaskListenerState): void {
    const connect = async () => {
      try {
        const result = await state.opcClient.event.subscribe(undefined, {
          signal: state.abortController.signal,
          sseMaxRetryAttempts: SSE_MAX_RETRY,
          sseDefaultRetryDelay: SSE_RETRY_DELAY,
          sseMaxRetryDelay: SSE_MAX_RETRY_DELAY,
        });

        for await (const event of result.stream) {
          if (state.abortController.signal.aborted) break;
          await this.handleEvent(state, event as OpencodeEvent);
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") return;
        log.warn(
          { taskId: state.taskId, error },
          "SSE subscription failed, reconnecting",
        );

        if (!state.abortController.signal.aborted) {
          setTimeout(() => connect(), SSE_RETRY_DELAY);
        }
      }
    };

    connect();
  }

  private async handleEvent(
    state: TaskListenerState,
    event: OpencodeEvent,
  ): Promise<void> {
    const relevant = [
      "session.status",
      "session.idle",
      "permission.asked",
      "permission.replied",
      "question.asked",
      "question.replied",
      "question.rejected",
      "todo.updated",
    ];

    if (!relevant.includes(event.type)) return;

    if (event.type === "session.status" || event.type === "session.idle") {
      await this.quickReactionSync(state);
    }

    this.scheduleProgressUpdate(state);
  }

  private async quickReactionSync(state: TaskListenerState): Promise<void> {
    try {
      const { data: statuses } = await state.opcClient.session.status();
      const statusMap = (statuses ?? {}) as Record<string, { type: string }>;
      const hasBusy = Object.values(statusMap).some((s) => s.type === "busy");

      if (hasBusy) {
        state.wasBusy = true;
        if (!state.activeReactions.has(REACTION_THINKING)) {
          await state.adapter.addReaction(state.event, REACTION_THINKING);
          state.activeReactions.add(REACTION_THINKING);
        }
      } else if (state.activeReactions.has(REACTION_THINKING)) {
        await state.adapter.removeReaction(state.event, REACTION_THINKING);
        state.activeReactions.delete(REACTION_THINKING);
      }
    } catch (error) {
      log.debug({ taskId: state.taskId, error }, "Quick reaction sync failed");
    }
  }

  private scheduleProgressUpdate(state: TaskListenerState): void {
    if (state.updateTimer) return;

    state.updateTimer = setTimeout(async () => {
      state.updateTimer = undefined;
      await this.performProgressUpdate(state);
    }, UPDATE_DEBOUNCE_MS);
  }

  private async performProgressUpdate(state: TaskListenerState): Promise<void> {
    const progressState = await this.computeProgressState(state);

    await this.syncReactions(state, progressState);

    if (state.progressMessageId && state.adapter.updateProgressMessage) {
      try {
        await state.adapter.updateProgressMessage(
          state.event,
          state.progressMessageId,
          progressState,
        );
      } catch (error) {
        log.debug(
          { taskId: state.taskId, error },
          "Failed to update progress message",
        );
      }
    }
  }

  private async computeProgressState(
    state: TaskListenerState,
  ): Promise<ProgressState> {
    const task = this.deps.taskService.getById(state.taskId);
    const sandbox = task?.data.sandboxId
      ? this.deps.sandboxService.getById(task.data.sandboxId)
      : undefined;

    const urls = {
      dashboard: dashboardUrl,
      opencode: sandbox?.runtime?.urls?.opencode ?? dashboardUrl,
    };

    let sessionStatus: "idle" | "busy" | "unknown" = "unknown";
    const todos: TodoItem[] = [];
    let currentTask: string | undefined;
    let attention: AttentionItem | undefined;

    try {
      const { data: statuses } = await state.opcClient.session.status();
      const statusMap = (statuses ?? {}) as Record<string, { type: string }>;
      const hasBusy = Object.values(statusMap).some((s) => s.type === "busy");

      if (hasBusy) {
        sessionStatus = "busy";
        state.wasBusy = true;
      } else {
        sessionStatus = "idle";
      }

      const { data: permissions } = await state.opcClient.permission.list();
      const pendingPerms = permissions ?? [];

      const { data: questions } = await state.opcClient.question.list();
      const pendingQs = questions ?? [];

      if (pendingPerms.length > 0) {
        const perm = pendingPerms[0];
        attention = {
          type: "permission",
          description: `Permission: ${perm?.permission ?? "Action required"}`,
          url: urls.opencode,
        };
      } else if (pendingQs.length > 0) {
        const q = pendingQs[0];
        const questionText =
          q?.questions?.[0]?.header ??
          q?.questions?.[0]?.question ??
          "Question";
        attention = {
          type: "question",
          description: questionText,
          url: urls.opencode,
        };
      }

      const { data: sessions } = await state.opcClient.session.list();
      for (const session of sessions ?? []) {
        try {
          const { data: sessionTodos } = await state.opcClient.session.todo({
            sessionID: session.id,
          });
          for (const todo of sessionTodos ?? []) {
            todos.push({
              content: todo.content,
              status: todo.status as TodoItem["status"],
            });
            if (todo.status === "in_progress") {
              currentTask = todo.content;
            }
          }
        } catch {
          /* session todo fetch can fail if session was just deleted */
        }
      }
    } catch (error) {
      log.debug(
        { taskId: state.taskId, error },
        "Failed to fetch OpenCode state",
      );
    }

    let status: ProgressState["status"];
    if (attention) {
      status = "attention";
    } else if (sessionStatus === "busy") {
      status = "running";
    } else if (sessionStatus === "idle" && state.wasBusy) {
      status = "completed";
    } else {
      status = "starting";
    }

    const durationMs = Date.now() - state.startedAt;

    return {
      status,
      sandboxId: task?.data.sandboxId ?? "",
      urls,
      startedAt: new Date(state.startedAt).toISOString(),
      ...(status === "completed" && {
        completedAt: new Date().toISOString(),
      }),
      duration: formatDuration(durationMs),
      todos,
      currentTask,
      attention,
    };
  }

  private async syncReactions(
    state: TaskListenerState,
    progressState: ProgressState,
  ): Promise<void> {
    const desired = new Set<string>();

    if (progressState.status === "running") {
      desired.add(REACTION_THINKING);
    }
    if (progressState.status === "attention") {
      desired.add(REACTION_ATTENTION);
    }

    for (const reaction of desired) {
      if (!state.activeReactions.has(reaction)) {
        await state.adapter.addReaction(state.event, reaction);
        state.activeReactions.add(reaction);
      }
    }

    for (const reaction of [...state.activeReactions]) {
      if (!desired.has(reaction)) {
        await state.adapter.removeReaction(state.event, reaction);
        state.activeReactions.delete(reaction);
      }
    }
  }
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return `${minutes}m ${secs}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}
