import { Check, Pencil, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { Sandbox } from "@/api/client";
import { useRenameSandbox } from "@/api/queries";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SheetTitle } from "@/components/ui/sheet";

export function SandboxNameEditor({ sandbox }: { sandbox: Sandbox }) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const renameMutation = useRenameSandbox();

  const startEditing = () => {
    setDraft(sandbox.name ?? "");
    setIsEditing(true);
  };

  const cancel = () => {
    setIsEditing(false);
    setDraft("");
  };

  const save = () => {
    const next = draft.trim();
    if (next === (sandbox.name ?? "")) {
      cancel();
      return;
    }
    renameMutation.mutate(
      { id: sandbox.id, name: next },
      {
        onSuccess: () => {
          setIsEditing(false);
          toast.success(next ? "Sandbox renamed" : "Sandbox name cleared");
        },
        onError: () => toast.error("Failed to rename sandbox"),
      },
    );
  };

  if (isEditing) {
    return (
      <div className="flex items-center gap-1 min-w-0">
        <SheetTitle className="sr-only">Rename sandbox</SheetTitle>
        <Input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              save();
            } else if (e.key === "Escape") {
              cancel();
            }
          }}
          maxLength={200}
          placeholder="Sandbox name"
          className="h-8 w-56 text-base"
          disabled={renameMutation.isPending}
        />
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-8 w-8 shrink-0"
          onClick={save}
          disabled={renameMutation.isPending}
          title="Save name"
        >
          <Check className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-8 w-8 shrink-0"
          onClick={cancel}
          disabled={renameMutation.isPending}
          title="Cancel"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    );
  }

  return (
    <div className="group/name flex items-center gap-1.5 min-w-0">
      <SheetTitle className="text-lg sm:text-xl truncate">
        {sandbox.name ? (
          <span>{sandbox.name}</span>
        ) : (
          <span className="font-mono">{sandbox.id}</span>
        )}
      </SheetTitle>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="h-6 w-6 shrink-0 opacity-0 transition-opacity group-hover/name:opacity-100 focus-visible:opacity-100"
        onClick={startEditing}
        title="Rename sandbox"
      >
        <Pencil className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
