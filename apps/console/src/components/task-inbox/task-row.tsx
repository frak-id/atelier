import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Box,
  Check,
  ExternalLink,
  GitBranch,
  MessageSquarePlus,
  Square,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import { type KeyboardEvent, useState } from "react";
import { sandboxDetailQuery } from "@/api/queries/sandboxes";
import {
  type InboxTask,
  useCancelTask,
  useCloseTask,
  useSendTaskPrompt,
} from "@/api/queries/tasks";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  OverflowMenu,
  type OverflowMenuItem,
} from "@/components/ui/overflow-menu";
import { Textarea } from "@/components/ui/textarea";
import { formatRelativeTime } from "@/lib/formatters";
import { harnessFromAnnotations } from "@/lib/sandbox-status";

const STATUS_BADGE = {
  running: { label: "Running", variant: "info" },
  idle: { label: "Finished", variant: "success" },
  failed: { label: "Failed", variant: "danger" },
  cancelled: { label: "Cancelled", variant: "neutral" },
} as const;

function ResultChips({ result }: { result: NonNullable<InboxTask["result"]> }) {
  const chips = [
    result.branch ? (
      <span key="branch" className="flex items-center gap-1 font-mono">
        <GitBranch className="size-3" />
        {result.branch}
      </span>
    ) : null,
    result.commitsAhead ? (
      <span key="ahead">+{result.commitsAhead} commits ahead</span>
    ) : null,
    result.diffStat ? (
      <span key="diff" className="font-mono">
        {result.diffStat.trim()}
      </span>
    ) : null,
  ].filter(Boolean);
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {chips}
    </div>
  );
}

/**
 * One task: what it is, where it ran, what it produced, and what to do next.
 * Actions render inline from `sm` up and collapse into an overflow menu on a
 * phone, where "Follow up" stays one tap away.
 */
export function TaskRow({
  task,
  unseen,
  onOpenTerminal,
  onSeen,
}: {
  task: InboxTask;
  /** Highlight as waiting on the user. */
  unseen: boolean;
  onOpenTerminal: (sandboxId: string) => void;
  /** Opening or acting on the task marks it seen. */
  onSeen: (task: InboxTask) => void;
}) {
  const navigate = useNavigate();
  const [promptOpen, setPromptOpen] = useState(false);
  const [text, setText] = useState("");
  const [closeOpen, setCloseOpen] = useState(false);
  const sendPrompt = useSendTaskPrompt();
  const cancel = useCancelTask();
  const close = useCloseTask();
  const { data: sandbox } = useQuery(sandboxDetailQuery(task.sandboxId));

  const badge = STATUS_BADGE[task.status as keyof typeof STATUS_BADGE] ?? {
    label: task.status,
    variant: "outline" as const,
  };
  const running = task.status === "running";
  const sandboxRunning = sandbox?.status === "running";
  const harness = harnessFromAnnotations(sandbox?.annotations);
  const harnessUrl = harness
    ? sandbox?.urls.find((u) => u.name === harness)
    : undefined;

  function submitPrompt() {
    const value = text.trim();
    if (!value || sendPrompt.isPending) return;
    sendPrompt.mutate(
      { taskId: task.taskId, text: value },
      {
        onSuccess: () => {
          setText("");
          setPromptOpen(false);
          onSeen(task);
        },
      },
    );
  }

  function onPromptKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitPrompt();
    }
  }

  const actions: (OverflowMenuItem | false)[] = [
    unseen &&
      !running && {
        key: "seen",
        label: "Mark seen",
        icon: <Check />,
        onSelect: () => onSeen(task),
      },
    !running && {
      key: "follow-up",
      label: "Follow up",
      icon: <MessageSquarePlus />,
      onSelect: () => {
        onSeen(task);
        setPromptOpen(true);
      },
    },
    !!harnessUrl &&
      sandboxRunning && {
        key: "agent",
        label: `Open ${harness}`,
        icon: <ExternalLink />,
        onSelect: () => {
          onSeen(task);
          window.open(harnessUrl.url, "_blank", "noopener,noreferrer");
        },
      },
    sandboxRunning && {
      key: "terminal",
      label: "Terminal",
      icon: <TerminalSquare />,
      onSelect: () => {
        onSeen(task);
        onOpenTerminal(task.sandboxId);
      },
    },
    {
      key: "sandbox",
      label: "Go to sandbox",
      icon: <Box />,
      onSelect: () => {
        onSeen(task);
        navigate({
          to: "/sandboxes/$sandboxId",
          params: { sandboxId: task.sandboxId },
        });
      },
    },
    running && {
      key: "cancel",
      label: "Cancel",
      icon: <Square />,
      onSelect: () => cancel.mutate(task.taskId),
    },
    {
      key: "close",
      label: "Close",
      icon: <Trash2 />,
      destructive: true,
      onSelect: () => setCloseOpen(true),
    },
  ];
  const items = actions.filter((a): a is OverflowMenuItem => a !== false);
  // On a phone the follow-up stays a visible button; the rest overflow.
  const primary = items.find((i) => i.key === "follow-up");
  const overflow = items.filter((i) => i !== primary);

  return (
    <div
      className={
        unseen
          ? "space-y-2 rounded-lg border border-primary/40 bg-card p-3"
          : "space-y-2 rounded-lg border bg-card p-3"
      }
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 break-words text-sm font-medium">
              {task.title}
            </span>
            <Badge variant={badge.variant}>{badge.label}</Badge>
            <Badge variant="outline">
              {task.source === "mcp" ? "agent" : "console"}
            </Badge>
          </div>
          <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            <Link
              to="/sandboxes/$sandboxId"
              params={{ sandboxId: task.sandboxId }}
              className="truncate underline-offset-2 hover:underline"
            >
              {task.sandboxName ?? task.sandboxId}
            </Link>
            <span>· {formatRelativeTime(task.updatedAt)}</span>
            {task.turns > 1 ? <span>· {task.turns} turns</span> : null}
          </div>
          {task.result ? <ResultChips result={task.result} /> : null}
          {task.status === "failed" && task.lastError ? (
            <p className="line-clamp-3 break-words text-xs text-destructive">
              {task.lastError}
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <div className="hidden flex-wrap justify-end gap-1 sm:flex">
            {items.map((item) => (
              <Button
                key={item.key}
                variant={item.destructive ? "ghost" : "outline"}
                size="sm"
                onClick={item.onSelect}
                title={item.label}
                aria-label={item.label}
              >
                {item.icon}
                <span className="hidden lg:inline">{item.label}</span>
              </Button>
            ))}
          </div>
          <div className="flex w-full items-center gap-2 sm:hidden">
            {primary ? (
              <Button
                variant="outline"
                size="touch"
                className="flex-1"
                onClick={primary.onSelect}
              >
                {primary.icon}
                {primary.label}
              </Button>
            ) : (
              <span className="flex-1" />
            )}
            <OverflowMenu items={overflow} />
          </div>
        </div>
      </div>

      {promptOpen ? (
        <div className="space-y-2">
          <Textarea
            autoFocus
            rows={3}
            value={text}
            placeholder="Follow-up prompt — Enter to send, Shift+Enter for a new line"
            aria-label="Follow-up prompt"
            className="text-base sm:text-xs"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onPromptKeyDown}
          />
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="touch"
              onClick={() => setPromptOpen(false)}
            >
              Cancel
            </Button>
            <Button
              size="touch"
              loading={sendPrompt.isPending}
              disabled={!text.trim()}
              onClick={submitPrompt}
            >
              Send
            </Button>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={closeOpen}
        onOpenChange={setCloseOpen}
        title="Close task?"
        description="The agent session ends and the task and its replies are forgotten. The sandbox and its files are untouched."
        confirmLabel="Close task"
        onConfirm={async () => {
          await close.mutateAsync(task.taskId);
        }}
      />
    </div>
  );
}
