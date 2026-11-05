/**
 * Agent tasks — "dispatch a prompt to a sandbox's agent and come back for the
 * result". A task is ONE server-driven ACP session (opened through
 * {@link AgentDispatch.openSession}) plus the bookkeeping a fire-and-forget
 * caller (an MCP client, a script) needs and the interactive dashboard does
 * not: per-turn status, the captured reply and automatic cleanup. The agent
 * never waits on a permission: {@link AgentDispatch} auto-approves.
 *
 * Why this exists: `session/prompt` blocks until the whole agent turn ends
 * and ACP streams the answer as `session/update` notifications the hub does
 * not retain. A caller that disconnects (or can't hold a request open for
 * minutes) would lose the reply, so the service runs each turn in the
 * background and accumulates the agent's message text as it streams.
 *
 * A task idle for an hour is PARKED, not forgotten: its hold on the shared
 * ACP connection is released (so the socket can close and the sandbox can
 * idle-pause), but the record stays. The next `sendPrompt` reopens the same
 * agent session (`session/load`), so the follow-up keeps the conversation,
 * also after the sandbox was paused and resumed (the reopen asks for the
 * sandbox to be running first). Parked tasks are forgotten after a week.
 *
 * The durable part of a task (ids, status, title, last reply, git result)
 * is persisted through a {@link TaskStore}; the live part (open session,
 * transcript) is per server process. After a restart a task comes back
 * parked: the next `sendPrompt` reopens its agent session, and a turn that
 * was running is reported failed. A closed task is deleted.
 *
 * `ownerId` is an opaque string supplied by the caller (api/ passes the
 * authenticated user id) — sessions/ never imports control/. A task is only
 * reachable by the owner that dispatched it; anyone else gets NotFound, so
 * task ids don't leak existence.
 */
import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { AgentTodo } from "@atelier/spec";
import { VM } from "../config/constants.ts";
import type { RuntimeService } from "../runtime/index.ts";
import {
  ConflictError,
  NotFoundError,
  ResourceExhaustedError,
  ValidationError,
} from "../shared/errors.ts";
import { safeNanoid } from "../shared/lib/id.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import type {
  AgentSession as AcpAgentSession,
  AgentDispatch,
} from "./acp/agent-dispatch.ts";
import type {
  StoredTask,
  StoredTaskStatus,
  TaskResult,
  TaskStore,
} from "./task.store.ts";
import { GIT_RESULT_COMMAND, parseGitResult } from "./task-result.ts";

const log = createChildLogger("agent-tasks");

const HARNESS_ANNOTATION = "atelier.dev/harness";

/** A task with no activity for this long (and no turn in flight) is parked:
 * its session hold on the shared ACP connection is released, and the next
 * prompt reopens the session. */
const DEFAULT_IDLE_TTL_MS = 60 * 60 * 1000;
/** A parked task is forgotten after this long without a prompt. */
const DEFAULT_RETAIN_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_SWEEP_MS = 60 * 1000;
const DEFAULT_MAX_TASKS_PER_OWNER = 20;
/** Per-turn cap on retained agent text (the tail wins; see `appendText`). */
const DEFAULT_MAX_REPLY_CHARS = 50_000;
const MAX_PROMPT_CHARS = 200_000;
const MAX_TURNS_PER_TASK = 100;
/** Tool calls retained per turn for the "what is it doing" view. */
const MAX_TOOL_CALLS_PER_TURN = 10;
const PROMPT_PREVIEW_CHARS = 120;
/** How long `cancel` waits for the agent to acknowledge, so the common case
 * returns the settled `cancelled` state rather than a stale `running`. */
const CANCEL_SETTLE_MS = 5_000;
/** Budget for the git summary taken when a turn ends. */
const RESULT_CAPTURE_MS = 5_000;
const TITLE_CHARS = 80;
/** Persisted cap on the last turn's concluding reply. */
const STORED_REPLY_CHARS = 8_000;

/** What the caller sees. `idle` = last turn finished and the task accepts
 * another prompt; `failed`/`cancelled` accept one too (a dead session just
 * fails the next turn fast). Only `closed` is terminal. */
type TaskStatus = StoredTaskStatus | "closed";

type TurnStatus = "running" | "completed" | "failed" | "cancelled";

interface TaskToolCallView {
  id: string;
  title: string;
  status: string;
}

interface TaskTurnView {
  index: number;
  status: TurnStatus;
  prompt: string;
  /** ACP stop reason once the turn ends (`end_turn`, `max_tokens`,
   * `refusal`, `cancelled`, ...). */
  stopReason?: string;
  error?: string;
  /** The agent's concluding message: its last non-empty message segment.
   * Agents narrate between tool calls; use `full` to read all of it. */
  reply: string;
  /** Every message segment of the turn, oldest first. Only with `full`. */
  segments?: string[];
  /** Older text was dropped to stay under the per-turn size cap. */
  truncated: boolean;
  startedAt: string;
  endedAt?: string;
  /** Most recent tool calls, oldest first (bounded). */
  toolCalls: TaskToolCallView[];
}

interface TaskView {
  taskId: string;
  sandboxId: string;
  sessionId: string;
  cwd: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  title: string;
  source: TaskSource;
  /** Git state captured when the last turn ended. */
  result?: TaskResult;
  /** The selected turn (the latest unless one was requested). */
  turn: TaskTurnView;
  /** Turns of this task in total, including those of earlier processes. */
  turnCount: number;
  /** The turns held in memory (none after a restart until a new prompt). */
  turns: { index: number; status: TurnStatus; prompt: string }[];
  todos: AgentTodo[];
}

/** A task as the inbox and the task list show it: the persisted record. */
interface TaskSummary {
  taskId: string;
  sandboxId: string;
  sessionId: string;
  cwd: string;
  harness: string;
  status: TaskStatus;
  title: string;
  source: TaskSource;
  turns: number;
  lastPrompt: string;
  lastError?: string;
  result?: TaskResult;
  createdAt: string;
  updatedAt: string;
}

/** One task with the concluding message of its last turn. */
interface TaskDetail extends TaskSummary {
  reply: string;
}

type TaskSource = StoredTask["source"];

interface DispatchTaskInput {
  sandboxId: string;
  prompt: string;
  /** Absolute working directory for the agent session (default: the dev
   * user's home, same as the dashboard). */
  cwd?: string;
  /** Who dispatched it (default: the console). */
  source?: TaskSource;
}

interface GetTaskOptions {
  /** Block up to this long while a turn is `running`. Returns early when it
   * finishes. */
  waitMs?: number;
  /** Which turn to detail (default: the latest). */
  turn?: number;
  /** Include every message segment, not just the concluding one. */
  full?: boolean;
}

interface TaskTurn {
  index: number;
  status: TurnStatus;
  prompt: string;
  stopReason?: string;
  error?: string;
  segments: string[];
  /** Whether the last segment may still receive chunks. Closed by a tool
   * call or a new `messageId`. */
  segmentOpen: boolean;
  lastMessageId?: string;
  chars: number;
  truncated: boolean;
  toolCalls: Map<string, TaskToolCallView>;
  startedAt: number;
  endedAt?: number;
}

interface TaskRecord {
  id: string;
  ownerId: string;
  sandboxId: string;
  sessionId: string;
  cwd: string;
  harnessId: string;
  title: string;
  source: TaskSource;
  createdAt: number;
  updatedAt: number;
  /** Status while no turn ran in this process (a restored task). */
  baseStatus: StoredTaskStatus;
  /** Turns of earlier processes: this process's `turns` start after them. */
  turnOffset: number;
  /** Persisted: the last finished turn's prompt, reply and error. */
  lastPrompt: string;
  lastReply: string;
  lastError?: string;
  result?: TaskResult;
  /** The open agent session; `undefined` while the task is parked. */
  handle: AcpAgentSession | undefined;
  /** In-flight reopen of a parked or disconnected session. */
  reopening?: Promise<void>;
  /** In-flight release of the session handle a park detached. */
  parking?: Promise<void>;
  turns: TaskTurn[];
  closed: boolean;
  /** Parked `get` waiters, resolved on any status-relevant change. */
  waiters: Set<() => void>;
}

export interface AgentTaskServiceDeps {
  runtime: Pick<RuntimeService, "getStatus" | "getLabels" | "exec">;
  store: TaskStore;
  dispatch: Pick<AgentDispatch, "openSession" | "todosFor">;
  idleTtlMs?: number;
  retainMs?: number;
  sweepMs?: number;
  maxTasksPerOwner?: number;
  maxReplyChars?: number;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > PROMPT_PREVIEW_CHARS
    ? `${flat.slice(0, PROMPT_PREVIEW_CHARS - 1)}…`
    : flat;
}

/** The first non-empty line of the prompt, truncated. */
function titleOf(prompt: string): string {
  const line = prompt.split("\n").find((l) => l.trim().length > 0) ?? "";
  const flat = line.trim();
  return flat.length > TITLE_CHARS
    ? `${flat.slice(0, TITLE_CHARS - 1)}…`
    : flat;
}

export class AgentTaskService {
  private readonly tasks = new Map<string, TaskRecord>();
  private sweepTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly idleTtlMs: number;
  private readonly retainMs: number;
  private readonly sweepMs: number;
  private readonly maxTasksPerOwner: number;
  private readonly maxReplyChars: number;

  constructor(private readonly deps: AgentTaskServiceDeps) {
    this.idleTtlMs = deps.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.retainMs = deps.retainMs ?? DEFAULT_RETAIN_MS;
    this.sweepMs = deps.sweepMs ?? DEFAULT_SWEEP_MS;
    this.maxTasksPerOwner =
      deps.maxTasksPerOwner ?? DEFAULT_MAX_TASKS_PER_OWNER;
    this.maxReplyChars = deps.maxReplyChars ?? DEFAULT_MAX_REPLY_CHARS;
    // Nothing runs yet in this process: a stored `running` turn is gone.
    deps.store.failInterrupted("The server restarted during this turn");
    this.pruneStore();
  }

  // ── public API ─────────────────────────────────────────────────────────────

  /** Open an agent session in the sandbox and start its first turn in the
   * background. Returns immediately; poll with {@link get}. */
  async dispatchTask(
    ownerId: string,
    input: DispatchTaskInput,
  ): Promise<TaskView> {
    const prompt = this.validatePrompt(input.prompt);
    this.makeRoomFor(ownerId);

    // Store reads, no agent round-trip.
    const status = this.deps.runtime.getStatus(input.sandboxId);
    if (!status) throw new NotFoundError("Sandbox", input.sandboxId);
    if (status !== "running") {
      throw new ConflictError(
        `Sandbox ${input.sandboxId} is ${status}; it must be running to accept agent tasks`,
      );
    }
    const harnessId = this.deps.runtime.getLabels(input.sandboxId)?.annotations[
      HARNESS_ANNOTATION
    ];
    if (!harnessId) {
      throw new ConflictError(
        `Sandbox ${input.sandboxId} has no agent harness (no ${HARNESS_ANNOTATION} annotation); agent tasks are unavailable`,
      );
    }

    const cwd = input.cwd ?? VM.HOME;
    // Updates only start once the first prompt is sent, i.e. after `task` is
    // assigned below; the guard is for the type, not a real race.
    let task: TaskRecord | undefined;
    const handle = await this.deps.dispatch.openSession({
      sandboxId: input.sandboxId,
      cwd,
      harnessId,
      callbacks: {
        onUpdate: (notification) => {
          if (task) this.handleUpdate(task, notification);
        },
      },
    });

    const now = Date.now();
    const record: TaskRecord = {
      id: `tsk_${safeNanoid()}`,
      ownerId,
      sandboxId: input.sandboxId,
      sessionId: handle.sessionId,
      cwd,
      harnessId,
      title: titleOf(prompt),
      source: input.source ?? "console",
      createdAt: now,
      updatedAt: now,
      baseStatus: "idle",
      turnOffset: 0,
      lastPrompt: "",
      lastReply: "",
      handle,
      turns: [],
      closed: false,
      waiters: new Set(),
    };
    task = record;
    this.tasks.set(record.id, record);
    this.armSweep();

    this.startTurn(record, prompt);
    log.info(
      { taskId: record.id, sandboxId: record.sandboxId, owner: ownerId },
      "Agent task dispatched",
    );
    return this.view(record, {});
  }

  /** Start another turn on an existing task. Rejected while a turn is in
   * flight (ACP prompts on one session don't queue). */
  async sendPrompt(
    ownerId: string,
    taskId: string,
    text: string,
  ): Promise<TaskView> {
    const prompt = this.validatePrompt(text);
    const task = this.requireTask(ownerId, taskId);
    this.assertCanPrompt(task);
    // The agent process may have restarted (a crash, a manual restart)
    // without the connection noticing; ask before prompting into it.
    const live = task.handle ? await task.handle.stillLive() : false;
    // Again: another prompt (or a reopen) may have started meanwhile.
    this.assertCanPrompt(task);
    if (!live || !task.handle?.live) {
      task.updatedAt = Date.now();
      task.reopening = this.reopen(task).finally(() => {
        task.reopening = undefined;
      });
      await task.reopening;
    }
    this.startTurn(task, prompt);
    return this.view(task, {});
  }

  async get(
    ownerId: string,
    taskId: string,
    options: GetTaskOptions = {},
  ): Promise<TaskView> {
    const task = this.requireTask(ownerId, taskId);
    task.updatedAt = Date.now();
    if (options.waitMs && options.waitMs > 0) {
      await this.waitWhileRunning(task, options.waitMs);
    }
    return this.view(task, options);
  }

  /** The owner's tasks, newest first, optionally for one sandbox. */
  list(ownerId: string, sandboxId?: string): TaskSummary[] {
    return this.deps.store
      .list({ ownerId, sandboxIds: sandboxId ? [sandboxId] : undefined })
      .map((t) => this.summaryOf(t));
  }

  /** Tasks of the given sandboxes (whoever dispatched them), newest first.
   * The caller decides which sandboxes the reader may see. */
  listForSandboxes(
    sandboxIds: string[],
    filter: { status?: StoredTaskStatus; limit?: number } = {},
  ): TaskSummary[] {
    return this.deps.store
      .list({ sandboxIds, ...filter })
      .map((t) => this.summaryOf(t));
  }

  /** One task by id without an ownership check: the caller must check access
   * to `sandboxId` itself. */
  describe(taskId: string): TaskDetail {
    const stored = this.deps.store.get(taskId);
    if (!stored) throw new NotFoundError("Task", taskId);
    const live = this.tasks.get(taskId);
    const reply =
      live?.turns.at(-1)?.status === "completed"
        ? this.turnReply(live.turns.at(-1))
        : stored.lastReply;
    return { ...this.summaryOf(stored), reply };
  }

  /** Cancel the in-flight turn. The task stays open for further prompts. */
  async cancel(ownerId: string, taskId: string): Promise<TaskView> {
    const task = this.requireTask(ownerId, taskId);
    const status = this.statusOf(task);
    if (status !== "running") {
      throw new ConflictError(
        `Task ${taskId} has no turn in flight (${status})`,
      );
    }
    await this.cancelInFlight(task);
    await this.waitWhileRunning(task, CANCEL_SETTLE_MS);
    return this.view(task, {});
  }

  /** End the task: cancel any in-flight turn, close the agent session and
   * forget the task (its transcript goes with it). */
  async close(ownerId: string, taskId: string): Promise<void> {
    await this.dispose(this.requireTask(ownerId, taskId));
  }

  /** Close every task (tests, shutdown hooks). */
  async closeAll(): Promise<void> {
    await Promise.all([...this.tasks.values()].map((t) => this.dispose(t)));
  }

  // ── turns ──────────────────────────────────────────────────────────────────

  private startTurn(task: TaskRecord, prompt: string): void {
    const turn: TaskTurn = {
      index: task.turnOffset + task.turns.length,
      status: "running",
      prompt,
      segments: [],
      segmentOpen: false,
      chars: 0,
      truncated: false,
      toolCalls: new Map(),
      startedAt: Date.now(),
    };
    task.turns.push(turn);
    task.updatedAt = turn.startedAt;
    task.lastPrompt = preview(prompt);
    this.persist(task);
    void this.runTurn(task, turn);
  }

  private assertCanPrompt(task: TaskRecord): void {
    if (task.closed) throw new NotFoundError("Task", task.id);
    const status = this.statusOf(task);
    if (status === "running") {
      throw new ConflictError(
        `Task ${task.id} is ${status}; wait for the current turn to finish (get_task) or cancel it first`,
      );
    }
    if (task.turnOffset + task.turns.length >= MAX_TURNS_PER_TASK) {
      throw new ConflictError(
        `Task ${task.id} reached ${MAX_TURNS_PER_TASK} turns; dispatch a new task`,
      );
    }
    if (task.reopening) {
      throw new ConflictError(
        `Task ${task.id} is reconnecting to its agent session; retry in a moment`,
      );
    }
  }

  private async runTurn(task: TaskRecord, turn: TaskTurn): Promise<void> {
    let status: TurnStatus;
    try {
      if (!task.handle) throw new Error("the task's agent session is closed");
      const response = await task.handle.prompt(turn.prompt);
      turn.stopReason = response.stopReason;
      status = response.stopReason === "cancelled" ? "cancelled" : "completed";
    } catch (err) {
      status = "failed";
      turn.error = errorMessage(err);
      log.warn(
        { taskId: task.id, sandboxId: task.sandboxId, err },
        "Agent task turn failed",
      );
    }
    // Before the status flips, so whoever sees the turn end sees its result.
    if (status !== "failed") {
      task.result = (await this.captureResult(task)) ?? task.result;
    }
    turn.status = status;
    turn.endedAt = Date.now();
    task.updatedAt = turn.endedAt;
    task.lastReply = this.turnReply(turn).slice(-STORED_REPLY_CHARS);
    task.lastError = turn.error;
    this.persist(task);
    this.wake(task);
  }

  /** Git summary of the task's working directory in the sandbox. Best effort:
   * a missing repo, a stopped sandbox or a slow exec just yield nothing. */
  private async captureResult(
    task: TaskRecord,
  ): Promise<TaskResult | undefined> {
    try {
      const { stdout } = await this.deps.runtime.exec(task.sandboxId, {
        command: GIT_RESULT_COMMAND,
        cwd: task.cwd,
        timeoutMs: RESULT_CAPTURE_MS,
      });
      return parseGitResult(stdout, new Date().toISOString());
    } catch (err) {
      log.debug({ taskId: task.id, err }, "Agent task result capture failed");
      return undefined;
    }
  }

  private async cancelInFlight(task: TaskRecord): Promise<void> {
    try {
      await task.handle?.cancel();
    } catch (err) {
      log.warn({ taskId: task.id, err }, "Agent task cancel failed");
    }
    task.updatedAt = Date.now();
  }

  // ── streaming capture ─────────────────────────────────────────────────────

  private handleUpdate(
    task: TaskRecord,
    notification: SessionNotification,
  ): void {
    const turn = task.turns.at(-1);
    if (turn?.status !== "running") return;
    const update = notification.update;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content.type === "text") {
          this.appendText(turn, update.content.text, update.messageId);
        }
        break;
      case "tool_call":
        turn.segmentOpen = false;
        this.upsertToolCall(turn, update.toolCallId, {
          title: update.title,
          status: update.status ?? "pending",
        });
        break;
      case "tool_call_update":
        this.upsertToolCall(turn, update.toolCallId, {
          title: update.title ?? undefined,
          status: update.status ?? undefined,
        });
        break;
      default:
        return;
    }
    task.updatedAt = Date.now();
  }

  /** Agents narrate between actions, so message text is kept as segments
   * split at tool calls (or a `messageId` change); the last one is "the
   * answer". Memory is bounded by dropping the OLDEST text first. */
  private appendText(
    turn: TaskTurn,
    chunk: string,
    messageId: string | null | undefined,
  ): void {
    if (!chunk) return;
    const id = messageId ?? undefined;
    const newMessage =
      id !== undefined &&
      turn.lastMessageId !== undefined &&
      id !== turn.lastMessageId;
    if (id !== undefined) turn.lastMessageId = id;
    if (!turn.segmentOpen || newMessage || turn.segments.length === 0) {
      turn.segments.push("");
      turn.segmentOpen = true;
    }
    const last = turn.segments.length - 1;
    turn.segments[last] = (turn.segments[last] ?? "") + chunk;
    turn.chars += chunk.length;

    while (turn.chars > this.maxReplyChars && turn.segments.length > 1) {
      turn.chars -= turn.segments.shift()?.length ?? 0;
      turn.truncated = true;
    }
    if (turn.chars > this.maxReplyChars) {
      const only = turn.segments[0] ?? "";
      turn.segments[0] = only.slice(only.length - this.maxReplyChars);
      turn.chars = this.maxReplyChars;
      turn.truncated = true;
    }
  }

  private upsertToolCall(
    turn: TaskTurn,
    id: string,
    patch: { title?: string; status?: string },
  ): void {
    const existing = turn.toolCalls.get(id);
    turn.toolCalls.set(id, {
      id,
      title: patch.title ?? existing?.title ?? id,
      status: patch.status ?? existing?.status ?? "pending",
    });
    while (turn.toolCalls.size > MAX_TOOL_CALLS_PER_TURN) {
      const oldest = turn.toolCalls.keys().next().value;
      if (oldest === undefined) break;
      turn.toolCalls.delete(oldest);
    }
  }

  // ── status / waiting ──────────────────────────────────────────────────────

  private statusOf(task: TaskRecord): TaskStatus {
    if (task.closed) return "closed";
    const turn = task.turns.at(-1);
    if (!turn) return task.baseStatus;
    switch (turn.status) {
      case "running":
        return "running";
      case "failed":
        return "failed";
      case "cancelled":
        return "cancelled";
      case "completed":
        return "idle";
    }
  }

  private wake(task: TaskRecord): void {
    const waiters = [...task.waiters];
    task.waiters.clear();
    for (const resolve of waiters) resolve();
  }

  /** Park until the task leaves `running` or the deadline passes. */
  private async waitWhileRunning(
    task: TaskRecord,
    waitMs: number,
  ): Promise<void> {
    const deadline = Date.now() + waitMs;
    while (this.statusOf(task) === "running") {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          task.waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, remaining);
        task.waiters.add(done);
      });
    }
  }

  // ── views ─────────────────────────────────────────────────────────────────

  private async view(
    task: TaskRecord,
    options: Pick<GetTaskOptions, "turn" | "full">,
  ): Promise<TaskView> {
    return {
      taskId: task.id,
      sandboxId: task.sandboxId,
      sessionId: task.sessionId,
      cwd: task.cwd,
      status: this.statusOf(task),
      title: task.title,
      source: task.source,
      ...(task.result && { result: task.result }),
      createdAt: new Date(task.createdAt).toISOString(),
      updatedAt: new Date(task.updatedAt).toISOString(),
      turn: this.selectTurn(task, options),
      turnCount: task.turnOffset + task.turns.length,
      turns: task.turns.map((t) => ({
        index: t.index,
        status: t.status,
        prompt: preview(t.prompt),
      })),
      todos: task.closed
        ? []
        : await this.deps.dispatch.todosFor(task.sandboxId, task.sessionId),
    };
  }

  /** The requested turn (default: the latest). A restored task has no
   * transcript: its latest turn is rebuilt from the persisted record. */
  private selectTurn(
    task: TaskRecord,
    options: Pick<GetTaskOptions, "turn" | "full">,
  ): TaskTurnView {
    const latest = task.turnOffset + task.turns.length - 1;
    const index = options.turn ?? latest;
    const turn = task.turns[index - task.turnOffset];
    if (turn) return this.turnView(turn, options.full ?? false);
    if (index === latest && task.turns.length === 0 && task.turnOffset > 0) {
      const at = new Date(task.updatedAt).toISOString();
      return {
        index,
        status: task.baseStatus === "idle" ? "completed" : task.baseStatus,
        prompt: task.lastPrompt,
        ...(task.lastError && { error: task.lastError }),
        reply: task.lastReply,
        ...(options.full && { segments: [task.lastReply] }),
        truncated: false,
        startedAt: at,
        endedAt: at,
        toolCalls: [],
      };
    }
    throw new NotFoundError("Turn", String(options.turn));
  }

  /** The turn's concluding message: its last non-empty segment. */
  private turnReply(turn: TaskTurn | undefined): string {
    const last = [...(turn?.segments ?? [])]
      .reverse()
      .find((s) => s.trim().length > 0);
    return (last ?? "").trim();
  }

  private turnView(turn: TaskTurn, full: boolean): TaskTurnView {
    return {
      index: turn.index,
      status: turn.status,
      prompt: turn.prompt,
      ...(turn.stopReason && { stopReason: turn.stopReason }),
      ...(turn.error && { error: turn.error }),
      reply: this.turnReply(turn),
      ...(full && { segments: turn.segments }),
      truncated: turn.truncated,
      startedAt: new Date(turn.startedAt).toISOString(),
      ...(turn.endedAt && { endedAt: new Date(turn.endedAt).toISOString() }),
      toolCalls: [...turn.toolCalls.values()],
    };
  }

  // ── lifecycle / eviction ──────────────────────────────────────────────────

  private validatePrompt(text: string): string {
    if (text.trim().length === 0) {
      throw new ValidationError("prompt must not be empty");
    }
    if (text.length > MAX_PROMPT_CHARS) {
      throw new ValidationError(
        `prompt exceeds ${MAX_PROMPT_CHARS} characters`,
      );
    }
    return text;
  }

  private requireTask(ownerId: string, taskId: string): TaskRecord {
    const task = this.tasks.get(taskId) ?? this.restore(taskId);
    // Same error for "unknown" and "someone else's": don't leak existence.
    if (!task || task.ownerId !== ownerId) {
      throw new NotFoundError("Task", taskId);
    }
    return task;
  }

  /** Bring a persisted task back into memory, parked. */
  private restore(taskId: string): TaskRecord | undefined {
    const stored = this.deps.store.get(taskId);
    if (!stored) return undefined;
    const record: TaskRecord = {
      id: stored.id,
      ownerId: stored.ownerId,
      sandboxId: stored.sandboxId,
      sessionId: stored.sessionId,
      cwd: stored.cwd,
      harnessId: stored.harness,
      title: stored.title,
      source: stored.source,
      createdAt: Date.parse(stored.createdAt),
      updatedAt: Date.parse(stored.updatedAt),
      baseStatus: stored.status,
      turnOffset: stored.turnCount,
      lastPrompt: stored.lastPrompt,
      lastReply: stored.lastReply,
      lastError: stored.lastError,
      result: stored.result,
      handle: undefined,
      turns: [],
      closed: false,
      waiters: new Set(),
    };
    this.tasks.set(record.id, record);
    this.armSweep();
    return record;
  }

  private persist(task: TaskRecord): void {
    if (task.closed) return;
    try {
      this.deps.store.upsert({
        id: task.id,
        ownerId: task.ownerId,
        sandboxId: task.sandboxId,
        sessionId: task.sessionId,
        cwd: task.cwd,
        harness: task.harnessId,
        status: this.statusOf(task) as StoredTaskStatus,
        title: task.title,
        source: task.source,
        turnCount: task.turnOffset + task.turns.length,
        lastPrompt: task.lastPrompt,
        lastReply: task.lastReply,
        ...(task.lastError && { lastError: task.lastError }),
        ...(task.result && { result: task.result }),
        createdAt: new Date(task.createdAt).toISOString(),
        updatedAt: new Date(task.updatedAt).toISOString(),
      });
    } catch (err) {
      log.warn({ taskId: task.id, err }, "Agent task persist failed");
    }
  }

  private summaryOf(stored: StoredTask): TaskSummary {
    return {
      taskId: stored.id,
      sandboxId: stored.sandboxId,
      sessionId: stored.sessionId,
      cwd: stored.cwd,
      harness: stored.harness,
      status: stored.status,
      title: stored.title,
      source: stored.source,
      turns: stored.turnCount,
      lastPrompt: stored.lastPrompt,
      ...(stored.lastError && { lastError: stored.lastError }),
      ...(stored.result && { result: stored.result }),
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
    };
  }

  private pruneStore(): void {
    this.deps.store.deleteUpdatedBefore(
      new Date(Date.now() - this.retainMs).toISOString(),
    );
  }

  /** Reopen a parked (or disconnected) task's agent session by id, so the
   * next turn continues the same conversation. */
  private async reopen(task: TaskRecord): Promise<void> {
    const status = this.deps.runtime.getStatus(task.sandboxId);
    if (!status) throw new NotFoundError("Sandbox", task.sandboxId);
    if (status !== "running") {
      throw new ConflictError(
        `Sandbox ${task.sandboxId} is ${status}; resume it (sandbox_lifecycle action=resume), then send the follow-up again: the task keeps its conversation`,
      );
    }
    // Closing the old handle drops the session's update handler, so it must
    // be done before the same session id is opened again.
    await task.parking;
    await this.releaseHandle(task);
    const handle = await this.deps.dispatch.openSession({
      sandboxId: task.sandboxId,
      cwd: task.cwd,
      harnessId: task.harnessId,
      resumeSessionId: task.sessionId,
      callbacks: { onUpdate: (n) => this.handleUpdate(task, n) },
    });
    if (task.closed) {
      // Closed (manage_task close) while reconnecting: don't keep the hold.
      await handle.close().catch(() => {});
      throw new NotFoundError("Task", task.id);
    }
    task.handle = handle;
    log.info(
      { taskId: task.id, sandboxId: task.sandboxId },
      "Agent task session reopened",
    );
  }

  /** Release the task's agent session (its hold on the shared ACP
   * connection, which is what lets the socket idle-close). */
  private async releaseHandle(task: TaskRecord): Promise<void> {
    const handle = task.handle;
    task.handle = undefined;
    if (!handle) return;
    try {
      await handle.close();
    } catch (err) {
      log.warn({ taskId: task.id, err }, "Agent task close failed");
    }
  }

  /** Make room under the per-owner cap by forgetting the owner's oldest
   * parked tasks; refuse only when tasks with an open session fill it. */
  private makeRoomFor(ownerId: string): void {
    const owned = [...this.tasks.values()]
      .filter((t) => t.ownerId === ownerId)
      .sort((a, b) => a.updatedAt - b.updatedAt);
    let excess = owned.length - this.maxTasksPerOwner + 1;
    for (const task of owned) {
      if (excess <= 0) return;
      if (task.handle || task.reopening) continue;
      void this.dispose(task);
      excess--;
    }
    if (excess > 0) throw new ResourceExhaustedError("Agent tasks");
  }

  private async dispose(task: TaskRecord): Promise<void> {
    if (task.closed) return;
    const status = this.statusOf(task);
    task.closed = true;
    this.tasks.delete(task.id);
    this.deps.store.delete(task.id);
    if (status === "running") {
      await this.cancelInFlight(task);
    }
    await task.parking;
    await this.releaseHandle(task);
    this.wake(task);
  }

  /** One timer for the whole service, armed only while tasks exist (so an
   * idle server has none), unref'd so it never keeps the process alive. A
   * timer rather than lazy eviction because the thing being reclaimed — a
   * held ACP socket — must be released even if nobody calls in again. */
  private armSweep(): void {
    if (this.sweepTimer || this.tasks.size === 0) return;
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = undefined;
      this.sweep();
      this.pruneStore();
      this.armSweep();
    }, this.sweepMs);
    this.sweepTimer.unref?.();
  }

  private sweep(): void {
    const now = Date.now();
    for (const task of [...this.tasks.values()]) {
      // A turn in flight is working, however quiet; everything else is
      // reclaimable once it goes stale.
      if (this.statusOf(task) === "running" || task.reopening) continue;
      if (task.handle && task.updatedAt < now - this.idleTtlMs) {
        log.info({ taskId: task.id }, "Parking idle agent task");
        this.park(task);
      } else if (!task.handle && task.updatedAt < now - this.retainMs) {
        log.info({ taskId: task.id }, "Forgetting parked agent task");
        void this.dispose(task);
      }
    }
  }

  /** Let go of an idle task's agent session, keeping the task. The handle is
   * detached at once (a prompt arriving now reopens rather than using it). */
  private park(task: TaskRecord): void {
    const handle = task.handle;
    if (!handle) return;
    task.handle = undefined;
    task.parking = handle
      .close()
      .catch((err) => {
        log.warn({ taskId: task.id, err }, "Agent task close failed");
      })
      .finally(() => {
        task.parking = undefined;
      });
  }
}
