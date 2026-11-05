import {
  Bell,
  BellOff,
  ChevronDown,
  ChevronRight,
  Inbox,
  Plus,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { InboxTask } from "@/api/queries/tasks";
import { NewTaskDialog } from "@/components/task-inbox/new-task-dialog";
import { TaskList } from "@/components/task-inbox/task-list";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useTaskInbox } from "@/hooks/use-task-inbox";
import { useTaskNotificationSetting } from "@/hooks/use-task-notifications";
import { countLabel } from "@/lib/formatters";

function Group({
  title,
  tasks,
  unseen,
}: {
  title: string;
  tasks: readonly InboxTask[];
  unseen: boolean;
}) {
  if (tasks.length === 0) return null;
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title} · {tasks.length}
      </h3>
      <TaskList
        tasks={tasks}
        unseenIds={new Set(unseen ? tasks.map((t) => t.taskId) : [])}
      />
    </div>
  );
}

function NotifyToggle() {
  const { supported, denied, active, toggle } = useTaskNotificationSetting();
  if (!supported) return null;
  return (
    <Button
      variant="ghost"
      size="touch"
      disabled={denied}
      aria-pressed={active}
      title={
        denied
          ? "Notifications are blocked in this browser"
          : "Notify me when a task finishes while this tab is hidden"
      }
      onClick={toggle}
    >
      {active ? <Bell /> : <BellOff />}
      <span className="hidden sm:inline">
        {active ? "Notifications on" : "Notify me"}
      </span>
    </Button>
  );
}

/** The home page's task inbox: tasks across every sandbox, grouped by what
 * needs the user. */
export function TaskInboxSection() {
  const { tasks, groups, isPending, isError, error, prune } = useTaskInbox();
  const [newOpen, setNewOpen] = useState(false);
  const [seenOpen, setSeenOpen] = useState(false);

  // Forget "seen" entries of tasks that are gone.
  // biome-ignore lint/correctness/useExhaustiveDependencies: run per poll, not per callback identity.
  useEffect(prune, [tasks]);

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-muted-foreground">Tasks</h2>
        <div className="flex items-center gap-1">
          <NotifyToggle />
          <Button size="touch" onClick={() => setNewOpen(true)}>
            <Plus />
            New task
          </Button>
        </div>
      </div>

      {isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : isError ? (
        <Card className="border-destructive/50">
          <CardHeader>
            <CardTitle>Failed to load tasks</CardTitle>
            <CardDescription>{error?.message}</CardDescription>
          </CardHeader>
        </Card>
      ) : !tasks || tasks.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="No tasks yet"
          description="Tasks appear when an orchestrating agent hands work to a sandbox (MCP send_prompt), or when you start one with New task."
        />
      ) : (
        <div className="space-y-4">
          <Group title="Needs review" tasks={groups.review} unseen />
          <Group title="Running" tasks={groups.running} unseen={false} />
          <Group title="Failed" tasks={groups.failed} unseen />
          {groups.seen.length > 0 ? (
            <div className="space-y-2">
              <Button
                variant="ghost"
                size="sm"
                aria-expanded={seenOpen}
                onClick={() => setSeenOpen((open) => !open)}
              >
                {seenOpen ? <ChevronDown /> : <ChevronRight />}
                Seen · {countLabel(groups.seen.length, "task")}
              </Button>
              {seenOpen ? (
                <TaskList tasks={groups.seen} unseenIds={new Set()} />
              ) : null}
            </div>
          ) : null}
        </div>
      )}

      <NewTaskDialog open={newOpen} onOpenChange={setNewOpen} />
    </section>
  );
}
