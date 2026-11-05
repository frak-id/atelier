import { TaskList } from "@/components/task-inbox/task-list";
import { useTaskInbox } from "@/hooks/use-task-inbox";
import { groupTasks } from "@/lib/task-inbox";

/** One sandbox's tasks (the inbox row component, filtered), newest first. */
export function SandboxTasks({ sandboxId }: { sandboxId: string }) {
  const { tasks, seen } = useTaskInbox();
  const mine = (tasks ?? []).filter((t) => t.sandboxId === sandboxId);
  if (mine.length === 0) return null;
  const { review, failed } = groupTasks(mine, seen);
  const unseenIds = new Set([...review, ...failed].map((t) => t.taskId));
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium text-muted-foreground">Tasks</h2>
      <TaskList tasks={mine} unseenIds={unseenIds} />
    </section>
  );
}
