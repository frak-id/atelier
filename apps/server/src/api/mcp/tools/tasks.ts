/**
 * Agent task tools — hand a prompt to the coding agent running inside a
 * sandbox and check back for the result. Thin binding over
 * `AgentTaskService` (`sessions/task.service.ts`), which owns the mechanism:
 * background turns, reply capture, permission handling, eviction.
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
import { safeTool, text } from "../format.ts";

/** MCP clients commonly time a request out at 60s; stay safely under it. */
const MAX_WAIT_SECONDS = 50;

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
        "return immediately with a `taskId`; the agent works in the " +
        "background. Poll with `get_task` (use `waitSeconds` to long-poll). " +
        "The sandbox must be running and have an agent harness. A task is " +
        "one agent session: follow up with `send_prompt`. If the agent asks " +
        "for a permission the task shows `waiting_permission` until you " +
        "answer with `reply_permission` — or pass `autoApprove` to allow " +
        "every request once, unattended. Tasks are kept in server memory " +
        "(lost on restart) and closed automatically after an hour idle.",
      inputSchema: {
        sandboxId: z.string(),
        prompt: z.string().min(1).describe("The instruction for the agent"),
        cwd: z
          .string()
          .optional()
          .describe("Absolute working directory (default: /home/dev)"),
        autoApprove: z
          .boolean()
          .optional()
          .describe(
            "Answer every permission request with allow-once instead of " +
              "waiting for `reply_permission`. Default false.",
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
        await tasks.get(user.id, started.taskId, {
          waitMs: (waitSeconds ?? 0) * 1000,
        }),
      );
    }),
  );

  server.registerTool(
    "get_task",
    {
      title: "Get task status and reply",
      description:
        "Read a task: `status` (running | waiting_permission | idle | " +
        "failed | cancelled | closed), the agent's reply for a turn " +
        "(`turn.reply` = its concluding message), recent tool calls, todos " +
        "and any `pendingPermissions`. `idle` means the turn finished and " +
        "the task accepts another `send_prompt`. Defaults to the latest " +
        "turn; pass `turn` for an earlier one and `full` to see every " +
        "message the agent wrote, not just the last.",
      inputSchema: {
        taskId: z.string(),
        turn: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Turn index to detail (default: latest)"),
        full: z
          .boolean()
          .optional()
          .describe("Include all message segments of the turn (`segments`)"),
        waitSeconds: waitSecondsSchema,
      },
    },
    safeTool(async ({ taskId, turn, full, waitSeconds }) =>
      text(
        await tasks.get(user.id, taskId, {
          turn,
          full,
          waitMs: (waitSeconds ?? 0) * 1000,
        }),
      ),
    ),
  );

  server.registerTool(
    "send_prompt",
    {
      title: "Send follow-up prompt to task",
      description:
        "Start another turn on an existing task, with the agent's context " +
        "from earlier turns. Only allowed when the task is not mid-turn " +
        "(`idle`, `failed` or `cancelled`); cancel or wait first otherwise. " +
        "Returns immediately unless `waitSeconds` is set.",
      inputSchema: {
        taskId: z.string(),
        prompt: z.string().min(1),
        waitSeconds: waitSecondsSchema,
      },
    },
    safeTool(async ({ taskId, prompt, waitSeconds }) => {
      await tasks.sendPrompt(user.id, taskId, prompt);
      return text(
        await tasks.get(user.id, taskId, {
          waitMs: (waitSeconds ?? 0) * 1000,
        }),
      );
    }),
  );

  server.registerTool(
    "list_tasks",
    {
      title: "List tasks",
      description:
        "List your agent tasks (newest first), optionally for one sandbox. " +
        "Tasks live in server memory; ones lost to a restart or idle " +
        "eviction no longer appear.",
      inputSchema: { sandboxId: z.string().optional() },
    },
    safeTool(async ({ sandboxId }) => text(tasks.list(user.id, sandboxId))),
  );

  server.registerTool(
    "reply_permission",
    {
      title: "Answer a task's permission request",
      description:
        "Answer a permission request the agent raised (see " +
        "`pendingPermissions` on `get_task`, status `waiting_permission`): " +
        "`once` allows this request, `always` allows it for the rest of the " +
        "session, `reject` denies it.",
      inputSchema: {
        taskId: z.string(),
        requestId: z.string(),
        reply: z.enum(["once", "always", "reject"]),
      },
    },
    safeTool(async ({ taskId, requestId, reply }) =>
      text(await tasks.replyPermission(user.id, taskId, requestId, reply)),
    ),
  );

  server.registerTool(
    "manage_task",
    {
      title: "Cancel or close a task",
      description:
        "`cancel` stops the turn in flight (the task stays open for more " +
        "prompts); `close` cancels any running turn, ends the agent " +
        "session and forgets the task and its replies — read what you need " +
        "first.",
      inputSchema: {
        taskId: z.string(),
        action: z.enum(["cancel", "close"]),
      },
    },
    safeTool(async ({ taskId, action }) => {
      if (action === "cancel") {
        return text(await tasks.cancel(user.id, taskId));
      }
      await tasks.close(user.id, taskId);
      return text({ ok: true });
    }),
  );
}
