/**
 * Agent task tools — hand a prompt to the coding agent running inside a
 * sandbox and check back for the result. Thin binding over
 * `AgentTaskService` (`sessions/task.service.ts`), which owns the mechanism:
 * background turns, reply capture, permission handling, eviction. The service
 * keeps its full view types; this binding projects them into what an agent
 * needs (`taskView`), so the transcript never floods the caller's context.
 *
 * Three tools, each covering a family of calls:
 *   - `send_prompt`: `sandboxId` starts a task, `taskId` continues one.
 *   - `get_task`:    `taskId` reads one task, no `taskId` lists them.
 *   - `manage_task`: cancel, close, or answer a permission request.
 * Params that only make sense in one mode are rejected in the other (a
 * `ValidationError` naming them) rather than silently ignored: an agent that
 * believes `autoApprove` is on when it is not would stall.
 *
 * Typical flow for a caller:
 *   1. `create_sandbox` (a spec with an agent harness) — or reuse one.
 *   2. `send_prompt` with `sandboxId` — returns at once with a `taskId`.
 *   3. `get_task` with `waitSeconds` until `status` leaves `running`.
 *      `waiting_permission` means answer with `manage_task`
 *      action=reply_permission (or start the task with `autoApprove`);
 *      `idle` means the turn finished and `turn.reply` holds the answer.
 *   4. `send_prompt` with `taskId` for follow-ups (same agent context).
 *   5. `manage_task` to cancel a runaway turn or close the task when done.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuthUser } from "../../../control/index.ts";
import { ValidationError } from "../../../shared/errors.ts";
import type { ServerContainer } from "../../container.ts";
import { requireSandboxAccess } from "../../sandbox-guard.ts";
import { keepTail, rejectParams, safeTool, text } from "../format.ts";

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

const statusSchema = z.enum([
  "running",
  "waiting_permission",
  "idle",
  "failed",
  "cancelled",
]);

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
    "send_prompt",
    {
      title: "Send a prompt to a sandbox's agent",
      description:
        "Give the coding agent inside a sandbox an instruction; the agent " +
        "works in the background and this returns at once with the task " +
        "(`taskId`). Pass `sandboxId` to START a new task (the sandbox " +
        "must be `running` — check `get_sandbox` — and have an agent " +
        "harness), or `taskId` to CONTINUE one with a follow-up turn that " +
        "keeps the agent's earlier context (only when the task is not " +
        "mid-turn: `idle`, `failed` or `cancelled`; otherwise wait, or " +
        "`manage_task` action=cancel first; a task holds at most 100 " +
        "turns). Then `get_task` with `waitSeconds` for the answer, or set " +
        "`waitSeconds` here. If the agent asks for a permission the task " +
        "shows `waiting_permission` until you answer with `manage_task` " +
        "action=reply_permission — or start it with `autoApprove`. Tasks " +
        "live in server memory (lost on restart), are closed after an hour " +
        "without activity, and you can hold at most 20: `manage_task` " +
        "action=close the ones you are done with.",
      inputSchema: {
        sandboxId: z
          .string()
          .optional()
          .describe(
            "Start a NEW task in this running sandbox (see create_sandbox / " +
              "get_sandbox). Pass this or taskId, not both.",
          ),
        taskId: z
          .string()
          .optional()
          .describe(
            "CONTINUE this existing task (from send_prompt / get_task). " +
              "Pass this or sandboxId, not both.",
          ),
        prompt: z
          .string()
          .min(1)
          .max(MAX_PROMPT_CHARS)
          .describe("The instruction for the agent"),
        cwd: z
          .string()
          .optional()
          .describe(
            "New task only: absolute working directory (default: /home/dev)",
          ),
        autoApprove: z
          .boolean()
          .optional()
          .describe(
            "New task only. DANGEROUS: answer every permission request " +
              "(shell commands, file writes, ...) with allow-once without " +
              "asking you. Only for disposable sandboxes. Default false.",
          ),
        waitSeconds: waitSecondsSchema,
      },
    },
    safeTool(
      async ({ sandboxId, taskId, prompt, cwd, autoApprove, waitSeconds }) => {
        if (sandboxId !== undefined && taskId !== undefined) {
          throw new ValidationError(
            "Pass `sandboxId` to start a task or `taskId` to continue one, " +
              "not both",
          );
        }

        if (taskId !== undefined) {
          rejectParams(
            { cwd, autoApprove },
            "only apply when starting a task (pass `sandboxId`, not `taskId`)",
          );
          await tasks.sendPrompt(user.id, taskId, prompt);
          return text(
            taskView(
              await tasks.get(user.id, taskId, {
                waitMs: (waitSeconds ?? 0) * 1000,
              }),
            ),
          );
        }

        if (sandboxId === undefined) {
          throw new ValidationError(
            "Pass `sandboxId` to start a task or `taskId` to continue one",
          );
        }
        requireSandboxAccess(container, user.id, sandboxId);
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
      },
    ),
  );

  server.registerTool(
    "get_task",
    {
      title: "Get a task, or list tasks",
      description:
        "With `taskId`: read that task. `status`: `running` (turn in " +
        "progress), `waiting_permission` (answer `pendingPermissions` with " +
        "`manage_task` action=reply_permission), `idle` (turn finished), " +
        "`failed`/`cancelled`, `closed`. `idle`, `failed` and `cancelled` " +
        "all accept another `send_prompt`. `turn.reply` is the agent's " +
        "concluding message and only appears once the turn has ended; " +
        "while it runs you get `turn.progress` (latest narration) and " +
        "recent `toolCalls`. Pass `waitSeconds` to long-poll instead of " +
        "looping. Defaults to the latest turn (`turnCount` says how many " +
        "exist). view=full returns every message `segments` (instead of " +
        "`reply`), the prompt, timestamps and ids; it can be large. " +
        "Without `taskId`: list your tasks, newest first, optionally for " +
        "one `sandboxId` or `status`; tasks lost to a server restart or " +
        "idle eviction no longer appear (a `NOT_FOUND` for a `taskId` " +
        "means the same).",
      inputSchema: {
        taskId: z
          .string()
          .optional()
          .describe("Task to read (from send_prompt). Omit to list tasks."),
        sandboxId: z
          .string()
          .optional()
          .describe("List only: this sandbox's tasks"),
        status: statusSchema
          .optional()
          .describe("List only: tasks in this status"),
        turn: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "One task only: 0-based turn index, below `turnCount` " +
              "(default: latest)",
          ),
        view: z
          .enum(["summary", "full"])
          .optional()
          .describe("One task only: summary (default) or full"),
        maxChars: z
          .number()
          .int()
          .min(100)
          .optional()
          .describe(
            "One task only: keep at most this many trailing characters " +
              `of the reply (default ${DEFAULT_REPLY_CHARS}); ` +
              "`truncated` is set when cut.",
          ),
        waitSeconds: waitSecondsSchema,
      },
    },
    safeTool(
      async ({
        taskId,
        sandboxId,
        status,
        turn,
        view,
        maxChars,
        waitSeconds,
      }) => {
        if (taskId === undefined) {
          rejectParams(
            { turn, view, maxChars, waitSeconds },
            "only apply when reading one task (pass `taskId`)",
          );
          return text(
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
          );
        }

        rejectParams(
          { sandboxId, status },
          "only filter the task list (omit `taskId` to list)",
        );
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
      },
    ),
  );

  server.registerTool(
    "manage_task",
    {
      title: "Cancel, close or answer a task",
      description:
        "`cancel` stops the turn in flight (the task stays open for more " +
        "prompts) and returns the settled `status`. `close` cancels any " +
        "running turn, ends the agent session and forgets the task and " +
        "its replies — read what you need first. `reply_permission` " +
        "answers a permission request the agent raised (`pendingPermissions` " +
        "on `get_task`, status `waiting_permission`); needs `requestId` " +
        "and `decision`: `once` allows this request, `always` allows it " +
        "for the rest of the session when the agent supports that " +
        "(otherwise it acts as `once`), `reject` denies it. Returns the " +
        "task's new `status`; follow with `get_task`.",
      inputSchema: {
        taskId: z.string().describe("Task id from send_prompt / get_task"),
        action: z.enum(["cancel", "close", "reply_permission"]),
        requestId: z
          .string()
          .optional()
          .describe(
            "reply_permission only: `requestId` of the entry in " +
              "`pendingPermissions`",
          ),
        decision: z
          .enum(["once", "always", "reject"])
          .optional()
          .describe("reply_permission only"),
      },
    },
    safeTool(async ({ taskId, action, requestId, decision }) => {
      if (action === "reply_permission") {
        if (requestId === undefined || decision === undefined) {
          throw new ValidationError(
            "action=reply_permission requires `requestId` and `decision`",
          );
        }
        const view = await tasks.replyPermission(
          user.id,
          taskId,
          requestId,
          decision,
        );
        return text({ taskId, status: view.status });
      }

      rejectParams(
        { requestId, decision },
        "only apply to action=reply_permission",
      );
      if (action === "cancel") {
        const view = await tasks.cancel(user.id, taskId);
        return text({ taskId, status: view.status });
      }
      await tasks.close(user.id, taskId);
      return text({ taskId, status: "closed" });
    }),
  );
}
