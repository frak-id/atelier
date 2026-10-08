/**
 * Agent task tools — hand a prompt to the coding agent running inside a
 * sandbox and check back for the result. Thin binding over
 * `AgentTaskService` (`sessions/task.service.ts`), which owns the mechanism:
 * background turns, reply capture, permission handling, eviction. The service
 * keeps its full view types; this binding projects them into what an agent
 * needs (`taskView`), so the transcript never floods the caller's context.
 *
 * Typical flow for a caller:
 *   1. `create_sandbox` (a spec with an agent harness) — or reuse one.
 *   2. `dispatch_task` — returns at once with a `taskId`.
 *   3. `get_task` with `waitSeconds` until `status` leaves `running`.
 *      `waiting_permission` means answer `reply_permission` (or dispatch with
 *      `autoApprove`); `idle` means the turn finished and `turn.reply` holds
 *      the agent's answer.
 *   4. `send_prompt` for follow-ups on the same task (same agent context).
 *   5. `manage_task` to cancel a runaway turn or close the task when done.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuthUser } from "../../../control/index.ts";
import type { ServerContainer } from "../../container.ts";
import { keepTail, safeTool, text } from "../format.ts";

/** MCP clients commonly time a request out at 60s; stay safely under it. */
const MAX_WAIT_SECONDS = 50;
/** Mirrors the service's prompt cap, so clients can see it in the schema. */
const MAX_PROMPT_CHARS = 200_000;
const DEFAULT_REPLY_CHARS = 12_000;
/** While a turn runs, the latest narration is only a progress hint. */
const PROGRESS_CHARS = 500;
const TITLE_CHARS = 300;

type TaskViewData = Awaited<ReturnType<ServerContainer["tasks"]["get"]>>;

const waitSecondsSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_WAIT_SECONDS)
  .optional()
  .describe(
    `Block up to this many seconds (max ${MAX_WAIT_SECONDS}) while the ` +
      "turn runs; returns early when it finishes or needs a permission " +
      "decision. Default 0 (return immediately).",
  );

const sandboxIdSchema = z
  .string()
  .describe("A running sandbox (see create_sandbox / list_sandboxes)");

const taskIdSchema = z
  .string()
  .describe("Task id from dispatch_task / list_tasks");

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * The agent-facing task view. Default ("summary"): status, the selected
 * turn's outcome and anything awaiting you. `full` swaps the concluding
 * `reply` for every message `segments` and adds the prompt, ids and
 * timestamps.
 */
function taskView(
  v: TaskViewData,
  opts: { full?: boolean; maxChars?: number } = {},
) {
  const { turn } = v;
  const running = turn.status === "running";
  const maxChars = opts.maxChars ?? DEFAULT_REPLY_CHARS;
  const reply = keepTail(turn.reply, maxChars);

  const turnOut = {
    index: turn.index,
    status: turn.status,
    ...(opts.full
      ? {
          prompt: turn.prompt,
          segments: (turn.segments ?? []).map(
            (s) => keepTail(s, maxChars).text,
          ),
        }
      : running
        ? // Mid-turn the "reply" is narration, not an answer: label it so.
          turn.reply
          ? { progress: keepTail(turn.reply, PROGRESS_CHARS).text }
          : {}
        : { reply: reply.text }),
    ...(turn.stopReason && !running ? { stopReason: turn.stopReason } : {}),
    ...(turn.error ? { error: turn.error } : {}),
    ...(running || opts.full
      ? {
          toolCalls: turn.toolCalls.map((t) => ({
            title: clip(t.title, TITLE_CHARS),
            status: t.status,
          })),
        }
      : {}),
    ...(turn.truncated || (!running && !opts.full && reply.truncated)
      ? { truncated: true }
      : {}),
    ...(opts.full
      ? {
          startedAt: turn.startedAt,
          ...(turn.endedAt ? { endedAt: turn.endedAt } : {}),
        }
      : {}),
  };

  return {
    taskId: v.taskId,
    sandboxId: v.sandboxId,
    status: v.status,
    turnCount: v.turns.length,
    turn: turnOut,
    ...(v.pendingPermissions.length > 0
      ? {
          pendingPermissions: v.pendingPermissions.map((p) => ({
            requestId: p.id,
            title: clip(p.permission, TITLE_CHARS),
          })),
        }
      : {}),
    ...(v.todos.length > 0
      ? {
          todos: v.todos.map((t) => ({
            content: clip(t.content, TITLE_CHARS),
            status: t.status,
          })),
        }
      : {}),
    ...(opts.full
      ? {
          sessionId: v.sessionId,
          cwd: v.cwd,
          autoApprove: v.autoApprove,
          createdAt: v.createdAt,
          updatedAt: v.updatedAt,
          turns: v.turns.map((t) => ({
            index: t.index,
            status: t.status,
            prompt: t.prompt,
          })),
        }
      : {}),
  };
}

export function registerTaskTools(
  server: McpServer,
  container: ServerContainer,
  user: AuthUser,
): void {
  const { tasks } = container;

  server.registerTool(
    "dispatch_task",
    {
      title: "Dispatch task to sandbox agent",
      description:
        "Send a prompt to the coding agent inside a running sandbox and " +
        "return at once with a `taskId`; the agent works in the " +
        "background. Then call `get_task` with `waitSeconds` to wait for " +
        "the answer. The sandbox must be `running` (check `get_sandbox`) " +
        "and have an agent harness. A task is one agent session: follow " +
        "up with `send_prompt`. If the agent asks for a permission the " +
        "task shows `waiting_permission` until you answer with " +
        "`reply_permission` — or pass `autoApprove`. Tasks live in server " +
        "memory (lost on restart), are closed after an hour without " +
        "activity, and you can hold at most 20: `manage_task` action=close " +
        "the ones you are done with.",
      inputSchema: {
        sandboxId: sandboxIdSchema,
        prompt: z
          .string()
          .min(1)
          .max(MAX_PROMPT_CHARS)
          .describe("The instruction for the agent"),
        cwd: z
          .string()
          .optional()
          .describe("Absolute working directory (default: /home/dev)"),
        autoApprove: z
          .boolean()
          .optional()
          .describe(
            "DANGEROUS: answer every permission request (shell commands, " +
              "file writes, ...) with allow-once without asking you. Only " +
              "for disposable sandboxes. Default false.",
          ),
        waitSeconds: waitSecondsSchema,
      },
    },
    safeTool(async ({ sandboxId, prompt, cwd, autoApprove, waitSeconds }) => {
      const started = await tasks.dispatchTask(user.id, {
        sandboxId,
        prompt,
        cwd,
        autoApprove,
      });
      return text(
        taskView(
          waitSeconds
            ? await tasks.get(user.id, started.taskId, {
                waitMs: waitSeconds * 1000,
              })
            : started,
        ),
      );
    }),
  );

  server.registerTool(
    "get_task",
    {
      title: "Get task status and reply",
      description:
        "Read a task. `status`: `running` (turn in progress), " +
        "`waiting_permission` (answer `pendingPermissions` with " +
        "`reply_permission`), `idle` (turn finished), `failed`/`cancelled`, " +
        "`closed`. `idle`, `failed` and `cancelled` all accept another " +
        "`send_prompt`. `turn.reply` is the agent's concluding message and " +
        "only appears once the turn has ended; while it runs you get " +
        "`turn.progress` (latest narration) and recent `toolCalls`. Pass " +
        "`waitSeconds` to long-poll instead of looping. Defaults to the " +
        "latest turn (`turnCount` says how many exist). view=full returns " +
        "every message `segments` (instead of `reply`), the prompt, " +
        "timestamps and ids; it can be large.",
      inputSchema: {
        taskId: taskIdSchema,
        turn: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("0-based turn index, below `turnCount` (default: latest)"),
        view: z
          .enum(["summary", "full"])
          .optional()
          .describe("summary (default) or full"),
        maxChars: z
          .number()
          .int()
          .min(100)
          .optional()
          .describe(
            `Keep at most this many trailing characters of the reply ` +
              `(default ${DEFAULT_REPLY_CHARS}); \`truncated\` is set when cut.`,
          ),
        waitSeconds: waitSecondsSchema,
      },
    },
    safeTool(async ({ taskId, turn, view, maxChars, waitSeconds }) => {
      const full = view === "full";
      return text(
        taskView(
          await tasks.get(user.id, taskId, {
            turn,
            full,
            waitMs: (waitSeconds ?? 0) * 1000,
          }),
          { full, maxChars },
        ),
      );
    }),
  );

  server.registerTool(
    "send_prompt",
    {
      title: "Send follow-up prompt to task",
      description:
        "Start another turn on an existing task, with the agent's context " +
        "from earlier turns. Only allowed when the task is not mid-turn " +
        "(`idle`, `failed` or `cancelled`); wait or `manage_task` " +
        "action=cancel first otherwise. A task holds at most 100 turns. " +
        "Returns at once unless `waitSeconds` is set.",
      inputSchema: {
        taskId: taskIdSchema,
        prompt: z
          .string()
          .min(1)
          .max(MAX_PROMPT_CHARS)
          .describe("The follow-up instruction"),
        waitSeconds: waitSecondsSchema,
      },
    },
    safeTool(async ({ taskId, prompt, waitSeconds }) => {
      await tasks.sendPrompt(user.id, taskId, prompt);
      return text(
        taskView(
          await tasks.get(user.id, taskId, {
            waitMs: (waitSeconds ?? 0) * 1000,
          }),
        ),
      );
    }),
  );

  server.registerTool(
    "list_tasks",
    {
      title: "List tasks",
      description:
        "List your agent tasks, newest first, optionally for one sandbox " +
        "or status. Tasks lost to a server restart or idle eviction no " +
        "longer appear (a `NOT_FOUND` from `get_task` means the same).",
      inputSchema: {
        sandboxId: z.string().optional().describe("Only this sandbox's tasks"),
        status: z
          .enum([
            "running",
            "waiting_permission",
            "idle",
            "failed",
            "cancelled",
          ])
          .optional()
          .describe("Only tasks in this status"),
      },
    },
    safeTool(async ({ sandboxId, status }) =>
      text(
        tasks
          .list(user.id, sandboxId)
          .filter((t) => !status || t.status === status)
          .map((t) => ({
            taskId: t.taskId,
            sandboxId: t.sandboxId,
            status: t.status,
            turnCount: t.turns,
            lastPrompt: t.lastPrompt,
            updatedAt: t.updatedAt,
          })),
      ),
    ),
  );

  server.registerTool(
    "reply_permission",
    {
      title: "Answer a task's permission request",
      description:
        "Answer a permission request the agent raised (`pendingPermissions` " +
        "on `get_task`, status `waiting_permission`). `decision`: `once` " +
        "allows this request; `always` allows it for the rest of the " +
        "session when the agent supports that (otherwise it acts as " +
        "`once`); `reject` denies it. Returns the task's new `status`; " +
        "follow with `get_task`.",
      inputSchema: {
        taskId: taskIdSchema,
        requestId: z
          .string()
          .describe("`requestId` of the entry in `pendingPermissions`"),
        decision: z.enum(["once", "always", "reject"]),
      },
    },
    safeTool(async ({ taskId, requestId, decision }) => {
      const view = await tasks.replyPermission(
        user.id,
        taskId,
        requestId,
        decision,
      );
      return text({ taskId, status: view.status });
    }),
  );

  server.registerTool(
    "manage_task",
    {
      title: "Cancel or close a task",
      description:
        "`cancel` stops the turn in flight (the task stays open for more " +
        "prompts) and returns the settled `status`; `close` cancels any " +
        "running turn, ends the agent session and forgets the task and its " +
        "replies — read what you need first.",
      inputSchema: {
        taskId: taskIdSchema,
        action: z.enum(["cancel", "close"]),
      },
    },
    safeTool(async ({ taskId, action }) => {
      if (action === "cancel") {
        const view = await tasks.cancel(user.id, taskId);
        return text({ taskId, status: view.status });
      }
      await tasks.close(user.id, taskId);
      return text({ taskId, status: "closed" });
    }),
  );
}
