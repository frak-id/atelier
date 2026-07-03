import type { SandboxSummary } from "@atelier/spec";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Loader2, Pause, Play, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  sandboxListQuery,
  useDestroySandbox,
  usePauseSandbox,
  useResumeSandbox,
} from "@/api/queries/sandboxes";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRelativeTime } from "@/lib/formatters";
import {
  harnessFromAnnotations,
  sandboxStatusPresentation,
} from "@/lib/sandbox-status";

export const Route = createFileRoute("/")({
  component: SandboxesPage,
});

function SandboxesPage() {
  const {
    data: sandboxes,
    isPending,
    isError,
    error,
  } = useQuery(sandboxListQuery());

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="mb-4 text-xl font-semibold">Sandboxes</h1>
      {isPending ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : isError ? (
        <Card className="border-destructive/50">
          <CardHeader>
            <CardTitle>Failed to load sandboxes</CardTitle>
            <CardDescription>{error.message}</CardDescription>
          </CardHeader>
        </Card>
      ) : !sandboxes || sandboxes.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No sandboxes yet</CardTitle>
            <CardDescription>
              Spawn your first sandbox — spawning lands in the next milestone.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="space-y-2">
          {[...sandboxes]
            .sort((a, b) =>
              String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")),
            )
            .map((sandbox) => (
              <SandboxRow key={sandbox.id} sandbox={sandbox} />
            ))}
        </div>
      )}
    </div>
  );
}

function SandboxRow({ sandbox }: { sandbox: SandboxSummary }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const pause = usePauseSandbox();
  const resume = useResumeSandbox();
  const destroy = useDestroySandbox();
  const status = sandboxStatusPresentation(sandbox.status);
  const harness = harnessFromAnnotations(sandbox.annotations);

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <Link
          to="/sandboxes/$sandboxId"
          params={{ sandboxId: sandbox.id }}
          className="flex flex-1 flex-wrap items-center gap-2 min-w-0"
        >
          <span className="truncate font-mono text-sm">{sandbox.id}</span>
          <Badge variant={status.variant}>{status.label}</Badge>
          {harness ? <Badge variant="outline">{harness}</Badge> : null}
          <span className="text-xs text-muted-foreground">
            {formatRelativeTime(sandbox.createdAt)}
          </span>
        </Link>
        <div className="flex items-center gap-2">
          {sandbox.status === "running" ? (
            <Button
              variant="outline"
              size="icon"
              disabled={pause.isPending}
              onClick={() => pause.mutate(sandbox.id)}
              aria-label="Pause sandbox"
            >
              {pause.isPending ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Pause />
              )}
            </Button>
          ) : null}
          {sandbox.status === "paused" ? (
            <Button
              variant="outline"
              size="icon"
              disabled={resume.isPending}
              onClick={() => resume.mutate(sandbox.id)}
              aria-label="Resume sandbox"
            >
              {resume.isPending ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Play />
              )}
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="icon"
            disabled={destroy.isPending}
            onClick={() => setConfirmOpen(true)}
            aria-label="Destroy sandbox"
          >
            {destroy.isPending ? (
              <Loader2 className="animate-spin" />
            ) : (
              <Trash2 />
            )}
          </Button>
        </div>
      </CardContent>
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Destroy sandbox?</DialogTitle>
            <DialogDescription>
              This permanently deletes{" "}
              <span className="font-mono">{sandbox.id}</span>. This cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={destroy.isPending}
              onClick={() => {
                destroy.mutate(sandbox.id);
                setConfirmOpen(false);
              }}
            >
              Destroy
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
