import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { sandboxDetailQuery } from "@/api/queries/sandboxes";
import type { InboxTask } from "@/api/queries/tasks";
import { ImmersiveView } from "@/components/immersive-view";
import { TaskRow } from "@/components/task-inbox/task-row";
import { useTaskInbox } from "@/hooks/use-task-inbox";

/** Rows for a set of tasks, plus the terminal they can open. `unseenIds`
 * marks the rows waiting on the user. */
export function TaskList({
  tasks,
  unseenIds,
}: {
  tasks: readonly InboxTask[];
  unseenIds: ReadonlySet<string>;
}) {
  const { markTasksSeen } = useTaskInbox();
  const [terminalFor, setTerminalFor] = useState<string | null>(null);
  const { data: sandbox } = useQuery({
    // biome-ignore lint/style/noNonNullAssertion: non-null when `enabled` below.
    ...sandboxDetailQuery(terminalFor!),
    enabled: terminalFor !== null,
  });

  return (
    <div className="space-y-2">
      {tasks.map((task) => (
        <TaskRow
          key={task.taskId}
          task={task}
          unseen={unseenIds.has(task.taskId)}
          onOpenTerminal={setTerminalFor}
          onSeen={(t) => markTasksSeen([t])}
        />
      ))}
      {terminalFor && sandbox ? (
        <ImmersiveView
          sandbox={sandbox}
          initialTab="terminal"
          onClose={() => setTerminalFor(null)}
        />
      ) : null}
    </div>
  );
}
