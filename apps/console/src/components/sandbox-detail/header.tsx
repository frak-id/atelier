import type { SandboxState } from "@atelier/spec";
import { Link } from "@tanstack/react-router";
import {
  ExternalLink,
  ListTodo,
  Loader2,
  MessagesSquare,
  Pencil,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import {
  useDestroySandbox,
  usePauseSandbox,
  useResumeSandbox,
} from "@/api/queries/sandboxes";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ForkButton } from "@/components/fork-button";
import { KeepAwakeButton } from "@/components/keep-awake-button";
import { RenameSandboxDialog } from "@/components/rename-sandbox-dialog";
import { NewTaskDialog } from "@/components/task-inbox/new-task-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useTaskInbox } from "@/hooks/use-task-inbox";
import {
  harnessFromAnnotations,
  sandboxNameFromAnnotations,
  sandboxStatusPresentation,
} from "@/lib/sandbox-status";

/**
 * Action-first header: the title row, then the things you do most (terminal,
 * the harness's own UI, sessions, pause/resume, keep awake, fork, destroy).
 */
export function SandboxHeader({
  sandbox,
  onOpenTerminal,
  onDestroyed,
}: {
  sandbox: SandboxState;
  onOpenTerminal: () => void;
  onDestroyed: () => void;
}) {
  const [destroyOpen, setDestroyOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const { groups } = useTaskInbox();
  const needReview = [...groups.review, ...groups.failed].filter(
    (t) => t.sandboxId === sandbox.id,
  ).length;
  const pause = usePauseSandbox();
  const resume = useResumeSandbox();
  const destroy = useDestroySandbox();
  const status = sandboxStatusPresentation(sandbox.status);
  const harness = harnessFromAnnotations(sandbox.annotations);
  const name = sandboxNameFromAnnotations(sandbox.annotations);
  const harnessUrl = harness
    ? sandbox.urls.find((u) => u.name === harness)
    : undefined;
  const running = sandbox.status === "running";

  return (
    <div className="space-y-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Link to="/" className="text-sm text-muted-foreground underline">
          Sandboxes
        </Link>
        <span className="text-muted-foreground">/</span>
        {name ? (
          <>
            <span className="truncate text-sm font-medium">{name}</span>
            <span className="truncate font-mono text-xs text-muted-foreground">
              {sandbox.id}
            </span>
          </>
        ) : (
          <span className="truncate font-mono text-sm">{sandbox.id}</span>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={() => setRenameOpen(true)}
          aria-label="Rename sandbox"
          title="Rename"
        >
          <Pencil className="size-3.5" />
        </Button>
        <Badge variant={status.variant}>{status.label}</Badge>
        {harness ? <Badge variant="outline">{harness}</Badge> : null}
        {needReview > 0 ? (
          <Link
            to="/sandboxes/$sandboxId/sessions"
            params={{ sandboxId: sandbox.id }}
            className="text-xs text-primary underline"
          >
            {needReview} {needReview === 1 ? "task needs" : "tasks need"} review
          </Link>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {running ? (
          <Button size="touch" onClick={onOpenTerminal}>
            <TerminalSquare />
            Terminal
          </Button>
        ) : null}
        {running && harness ? (
          <Button
            size="touch"
            variant="outline"
            onClick={() => setTaskOpen(true)}
          >
            <ListTodo />
            New task
          </Button>
        ) : null}
        {running && harnessUrl ? (
          <Button asChild variant="outline" size="touch">
            <a href={harnessUrl.url} target="_blank" rel="noreferrer">
              <ExternalLink />
              Open {harness}
            </a>
          </Button>
        ) : null}
        <Button asChild variant="outline" size="touch">
          <Link
            to="/sandboxes/$sandboxId/sessions"
            params={{ sandboxId: sandbox.id }}
          >
            <MessagesSquare />
            Sessions
          </Link>
        </Button>
        {running ? (
          <Button
            variant="outline"
            size="touch"
            disabled={pause.isPending}
            onClick={() => pause.mutate(sandbox.id)}
          >
            {pause.isPending ? <Loader2 className="animate-spin" /> : null}
            Pause
          </Button>
        ) : null}
        {sandbox.status === "paused" ? (
          <Button
            variant="outline"
            size="touch"
            disabled={resume.isPending}
            onClick={() => resume.mutate(sandbox.id)}
          >
            {resume.isPending ? <Loader2 className="animate-spin" /> : null}
            Resume
          </Button>
        ) : null}
        {running ? (
          <KeepAwakeButton sandboxId={sandbox.id} size="touch" />
        ) : null}
        {running || sandbox.status === "paused" ? (
          <ForkButton sandboxId={sandbox.id} size="touch" />
        ) : null}
        <Button
          variant="destructive"
          size="touch"
          disabled={destroy.isPending}
          onClick={() => setDestroyOpen(true)}
        >
          <Trash2 />
          Destroy
        </Button>
      </div>

      <ConfirmDialog
        open={destroyOpen}
        onOpenChange={setDestroyOpen}
        title="Destroy sandbox?"
        description={
          <>
            This permanently deletes{" "}
            <span className="font-mono">{sandbox.id}</span>
            {name ? ` (${name})` : ""}. This cannot be undone.
          </>
        }
        confirmLabel="Destroy"
        onConfirm={async () => {
          await destroy.mutateAsync(sandbox.id);
          onDestroyed();
        }}
      />
      <NewTaskDialog
        open={taskOpen}
        onOpenChange={setTaskOpen}
        defaultSandboxId={sandbox.id}
      />
      <RenameSandboxDialog
        sandboxId={sandbox.id}
        currentName={name}
        open={renameOpen}
        onOpenChange={setRenameOpen}
      />
    </div>
  );
}
