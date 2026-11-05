/**
 * Sessions' table: the durable record of agent tasks. Like `runtime/db`, no FK
 * to any other module's tables — `owner_id` and `sandbox_id` are opaque ids
 * supplied by the caller. Turn transcripts stay in memory; the row keeps what
 * a task inbox needs after a restart (status, last reply, git result).
 */
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const agentTasks = sqliteTable(
  "agent_tasks",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    sandboxId: text("sandbox_id").notNull(),
    /** The ACP session id: `session/load` reopens the conversation by it. */
    sessionId: text("session_id").notNull(),
    cwd: text("cwd").notNull(),
    harness: text("harness").notNull(),
    /** running | idle | failed | cancelled (a closed task is deleted). */
    status: text("status").notNull(),
    /** The first prompt's first line, truncated. */
    title: text("title").notNull(),
    /** Who dispatched it: `mcp` or `console`. */
    source: text("source").notNull(),
    turnCount: integer("turn_count").notNull(),
    lastPrompt: text("last_prompt").notNull(),
    /** The concluding agent message of the last finished turn (truncated). */
    lastReply: text("last_reply").notNull(),
    lastError: text("last_error"),
    /** JSON `TaskResult`: git state captured at the end of the last turn. */
    result: text("result"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_agent_tasks_owner").on(t.ownerId),
    index("idx_agent_tasks_sandbox").on(t.sandboxId),
  ],
);
