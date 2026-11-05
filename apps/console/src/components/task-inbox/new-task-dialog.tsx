import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { sandboxListQuery } from "@/api/queries/sandboxes";
import { useStartTask } from "@/api/queries/tasks";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import {
  harnessFromAnnotations,
  sandboxNameFromAnnotations,
} from "@/lib/sandbox-status";

/**
 * Hand a prompt to the agent of a running sandbox (`POST /sessions/tasks`).
 * Only running sandboxes with an agent harness can take a task. The working
 * directory defaults server-side to the sandbox's first repo checkout.
 */
export function NewTaskDialog({
  open,
  onOpenChange,
  defaultSandboxId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Preselected sandbox (the detail page). */
  defaultSandboxId?: string;
}) {
  const { data: sandboxes } = useQuery({
    ...sandboxListQuery(),
    enabled: open,
  });
  const start = useStartTask();
  const [sandboxId, setSandboxId] = useState(defaultSandboxId ?? "");
  const [cwd, setCwd] = useState("");
  const [prompt, setPrompt] = useState("");

  const candidates = (sandboxes ?? []).filter(
    (s) => s.status === "running" && harnessFromAnnotations(s.annotations),
  );

  // Re-seed on every open.
  useEffect(() => {
    if (open) {
      setSandboxId(defaultSandboxId ?? "");
      setCwd("");
      setPrompt("");
    }
  }, [open, defaultSandboxId]);

  // Without a preselection, land on the first candidate once they load.
  const selected = sandboxId || candidates[0]?.id || "";

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!selected || !prompt.trim()) return;
    start.mutate(
      { sandboxId: selected, prompt: prompt.trim(), cwd: cwd.trim() },
      { onSuccess: () => onOpenChange(false) },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>New task</DialogTitle>
            <DialogDescription>
              The sandbox's agent works on it in the background; it shows up in
              the inbox when it needs you.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="new-task-sandbox">Sandbox</Label>
            <NativeSelect
              id="new-task-sandbox"
              value={selected}
              onChange={(e) => setSandboxId(e.target.value)}
            >
              {candidates.length === 0 ? (
                <option value="">No running sandbox with an agent</option>
              ) : null}
              {candidates.map((s) => (
                <option key={s.id} value={s.id}>
                  {sandboxNameFromAnnotations(s.annotations) ?? s.id}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-1">
            <Label htmlFor="new-task-cwd">Working directory (optional)</Label>
            <Input
              id="new-task-cwd"
              value={cwd}
              placeholder="Default: the sandbox's first repo"
              autoComplete="off"
              onChange={(e) => setCwd(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="new-task-prompt">Prompt</Label>
            <Textarea
              id="new-task-prompt"
              rows={6}
              value={prompt}
              autoFocus
              className="text-base sm:text-xs"
              placeholder="What should the agent do?"
              onChange={(e) => setPrompt(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              loading={start.isPending}
              disabled={!selected || !prompt.trim()}
            >
              Start task
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
