import { GitBranch, Trash2 } from "lucide-react";
import { BranchPicker } from "@/components/branch-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { parseRepoFullName, type RepoEntry } from "./types";

interface RepoItemProps {
  repo: RepoEntry;
  onUpdate: (updates: Partial<RepoEntry>) => void;
  onRemove: () => void;
  variant?: "card" | "muted";
}

export function RepoItem({
  repo,
  onUpdate,
  onRemove,
  variant = "card",
}: RepoItemProps) {
  const repoInfo = repo.repo ? parseRepoFullName(repo.repo) : null;
  const containerClass =
    variant === "card"
      ? "p-3 border rounded-lg space-y-2"
      : "p-3 bg-muted rounded-lg space-y-2";

  return (
    <div className={containerClass}>
      <div className="flex items-center gap-2 min-w-0">
        <span className="flex-1 font-mono text-sm truncate min-w-0">
          {repo.url || repo.repo}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="shrink-0 h-7 w-7 p-0"
          onClick={onRemove}
        >
          <Trash2 className="h-4 w-4 text-destructive" />
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Branch</Label>
          {repoInfo ? (
            <BranchPicker
              owner={repoInfo.owner}
              repo={repoInfo.repo}
              value={repo.branch}
              onChange={(branch) => onUpdate({ branch })}
            />
          ) : (
            <div className="flex items-center gap-2">
              <GitBranch className="h-4 w-4 text-muted-foreground" />
              <Input
                value={repo.branch}
                onChange={(e) => onUpdate({ branch: e.target.value })}
                className="h-8"
              />
            </div>
          )}
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Clone Path</Label>
          <Input
            value={repo.clonePath}
            onChange={(e) => onUpdate({ clonePath: e.target.value })}
            className="h-8"
          />
        </div>
      </div>
    </div>
  );
}
