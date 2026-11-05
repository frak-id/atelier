/**
 * Agent task tools — hand a prompt to the coding agent running inside a
 * sandbox and check back for the result. Thin binding over
 * `AgentTaskService` (`sessions/task.service.ts`), which owns the mechanism:
 * background turns, reply capture, eviction. Agents auto-approve every
 * permission request inside their sandbox, so a task never waits on one.
 * The service keeps its full view types; this binding projects them into
 * what an agent needs (`taskView`), so the transcript never floods the
 * caller's context.
 *
 * Three tools, each covering a family of calls:
 *   - `send_prompt`: `sandboxId` starts a task, `taskId` continues one.
 *   - `get_task`:    `taskId` reads one task, no `taskId` lists them.
 *   - `manage_task`: cancel or close.
 * Params that only make sense in one mode are rejected in the other (a
 * `ValidationError` naming them) rather than silently ignored.
 *
 * Typical flow for a caller:
 *   1. `create_sandbox` (a spec with an agent harness) — or reuse one.
 *   2. `send_prompt` with `sandboxId` — returns at once with a `taskId`.
 *   3. `get_task` with `waitSeconds` until `status` leaves `running`.
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
      "turn runs; returns early when it finishes. Default 0 (return " +
      "immediately).",
  );

const statusSchema = z.enum(["running", "idle", "failed", "cancelled"]);

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * The agent-facing task view. Default ("summary"): status, the selected
 * turn's outcome and the agent's todos. `full` swaps the concluding
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
    title: v.title,
    status: v.status,
    turnCount: v.turnCount,
    ...(v.result ? { result: v.result } : {}),
    turn: turnOut,
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

  /** The task's own view, once the caller still has access to its sandbox: a
   * task outlives a membership (it survives restarts for a week), so the
   * task owner is re-checked against the sandbox access rule on every use.
   * Looked up without waiting, so a denied caller never blocks. */
  const accessibleTask = async (taskId: string): Promise<TaskViewData> => {
    const found = await tasks.get(user.id, taskId);
    requireSandboxAccess(container, user.id, found.sandboxId);
    return found;
  };

  server.registerTool(
    "send_prompt",
    {
      title: "Send a prompt to a sandbox's agent",
      description:
        "Give the coding agent inside a sandbox an instruction; the agent " +
        "works in the background and this returns at once with the task " +
        "(`taskId`). Pass `sandboxId` to START a new task (the sandbox " +
        "must have an agent " +
        "harness), or `taskId` to CONTINUE one with a follow-up turn that " +
        "keeps the agent's earlier context (only when the task is not " +
        "mid-turn: `idle`, `failed` or `cancelled`; otherwise wait, or " +
        "`manage_task` action=cancel first; a task holds at most 100 " +
        "turns). Then `get_task` with `waitSeconds` for the answer, or set " +
        "`waitSeconds` here. The agent runs unattended: it never stops to " +
        "ask for a permission (the sandbox is its boundary). A follow-up " +
        "keeps the context even days later (a paused sandbox is resumed " +
        "first). " +
        "Tasks survive server restarts and are forgotten after a week " +
        "without a prompt; at most 20 at once are active " +
        "(older idle ones make room): `manage_task` action=close the ones " +
        "you are done with.",
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
        waitSeconds: waitSecondsSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    safeTool(
      "send_prompt",
      async ({ sandboxId, taskId, prompt, cwd, waitSeconds }) => {
        if (sandboxId !== undefined && taskId !== undefined) {
          throw new ValidationError(
            "Pass `sandboxId` to start a task or `taskId` to continue one, " +
              "not both",
          );
        }

        if (taskId !== undefined) {
          rejectParams(
            { cwd },
            "only apply when starting a task (pass `sandboxId`, not `taskId`)",
          );
          // The task's sandbox may have been paused since the last turn.
          const { sandboxId: taskSandboxId } = await accessibleTask(taskId);
          await container.sandboxOps.ensureRunning(taskSandboxId);
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
        await container.sandboxOps.ensureRunning(sandboxId);
        const started = await tasks.dispatchTask(user.id, {
          sandboxId,
          prompt,
          cwd,
          source: "mcp",
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
        "progress), `idle` (turn finished), `failed`/`cancelled`, " +
        "`closed`. `idle`, `failed` and `cancelled` " +
        "all accept another `send_prompt`. `turn.reply` is the agent's " +
        "concluding message and only appears once the turn has ended; " +
        "while it runs you get `turn.progress` (latest narration) and " +
        "recent `toolCalls`. Pass `waitSeconds` to long-poll instead of " +
        "looping. Defaults to the latest turn (`turnCount` says how many " +
        "exist). view=full returns every message `segments` (instead of " +
        "`reply`), the prompt, timestamps and ids; it can be large. " +
        "Without `taskId`: `{tasks}`, your tasks newest first, optionally for " +
        "one `sandboxId` or `status`; tasks closed or forgotten after a " +
        "week no longer appear (a `NOT_FOUND` for a `taskId` means the " +
        "same).",
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
      outputSchema: {
        tasks: z.array(z.object({}).passthrough()).optional(),
        taskId: z.string().optional(),
        sandboxId: z.string().optional(),
        status: z.string().optional(),
        turn: z.object({}).passthrough().optional(),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    safeTool(
      "get_task",
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
          return text({
            tasks: tasks
              .list(user.id, sandboxId)
              .filter((t) => !status || t.status === status)
              .filter((t) => {
                const labels = container.runtime.getLabels(t.sandboxId);
                return (
                  labels && container.control.canAccessSandbox(user.id, labels)
                );
              })
              .map((t) => ({
                taskId: t.taskId,
                sandboxId: t.sandboxId,
                title: t.title,
                status: t.status,
                ...(t.result ? { result: t.result } : {}),
                turnCount: t.turns,
                lastPrompt: t.lastPrompt,
                updatedAt: t.updatedAt,
              })),
          });
        }

        rejectParams(
          { sandboxId, status },
          "only filter the task list (omit `taskId` to list)",
        );
        await accessibleTask(taskId);
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
      title: "Cancel or close a task",
      description:
        "`cancel` stops the turn in flight (the task stays open for more " +
        "prompts) and returns the settled `status`. `close` cancels any " +
        "running turn, ends the agent session and forgets the task and " +
        "its replies — read what you need first.",
      inputSchema: {
        taskId: z.string().describe("Task id from send_prompt / get_task"),
        action: z.enum(["cancel", "close"]),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    safeTool("manage_task", async ({ taskId, action }) => {
      await accessibleTask(taskId);
      if (action === "cancel") {
        const view = await tasks.cancel(user.id, taskId);
        return text({ taskId, status: view.status });
      }
      await tasks.close(user.id, taskId);
      return text({ taskId, status: "closed" });
    }),
  );
}
