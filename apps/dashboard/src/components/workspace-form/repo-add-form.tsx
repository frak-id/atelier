import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Plus } from "lucide-react";
import { useState } from "react";
import { githubStatusQuery } from "@/api/queries";
import { BranchPicker } from "@/components/branch-picker";
import { RepositoryPicker } from "@/components/repository-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createEmptyRepo, parseRepoFullName, type RepoEntry } from "./types";

interface RepoAddFormProps {
  onAdd: (repo: RepoEntry) => void;
  onRepoSelected?: (repoName: string) => void;
  showCancel?: boolean;
  onCancel?: () => void;
}

export function RepoAddForm({
  onAdd,
  onRepoSelected,
  showCancel,
  onCancel,
}: RepoAddFormProps) {
  const { data: githubStatus } = useQuery(githubStatusQuery);
  const isGitHubConnected = githubStatus?.connected === true;

  const [showManualUrl, setShowManualUrl] = useState(false);
  const [newRepo, setNewRepo] = useState<RepoEntry>(createEmptyRepo());
  const [selectedRepoFullName, setSelectedRepoFullName] = useState<string>();

  const handleAdd = () => {
    if (newRepo.url) {
      onAdd(newRepo);
      setNewRepo(createEmptyRepo());
      setSelectedRepoFullName(undefined);
    }
  };

  const handleCancel = () => {
    setNewRepo(createEmptyRepo());
    setSelectedRepoFullName(undefined);
    setShowManualUrl(false);
    onCancel?.();
  };

  if (isGitHubConnected && !showManualUrl) {
    return (
      <div className="space-y-2">
        {showCancel && (
          <div className="flex items-center justify-between">
            <Label className="text-sm font-medium">Add Repository</Label>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleCancel}
            >
              Cancel
            </Button>
          </div>
        )}
        <RepositoryPicker
          value={newRepo.url}
          onSelect={(repo) => {
            setNewRepo({
              url: repo.cloneUrl,
              branch: repo.defaultBranch,
              clonePath: `/workspace/${repo.name}`,
            });
            setSelectedRepoFullName(repo.fullName);
            onRepoSelected?.(repo.name);
          }}
        />
        {selectedRepoFullName && (
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Branch</Label>
              <BranchPicker
                owner={parseRepoFullName(selectedRepoFullName).owner}
                repo={parseRepoFullName(selectedRepoFullName).repo}
                value={newRepo.branch}
                onChange={(branch) => setNewRepo({ ...newRepo, branch })}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">
                Clone Path
              </Label>
              <Input
                value={newRepo.clonePath}
                onChange={(e) =>
                  setNewRepo({ ...newRepo, clonePath: e.target.value })
                }
              />
            </div>
          </div>
        )}
        <div className="flex gap-2">
          {!selectedRepoFullName && (
            <Input
              placeholder="Clone path"
              value={newRepo.clonePath}
              onChange={(e) =>
                setNewRepo({ ...newRepo, clonePath: e.target.value })
              }
            />
          )}
          <Button
            type="button"
            onClick={handleAdd}
            disabled={!newRepo.url}
            className={selectedRepoFullName ? "w-full" : ""}
          >
            <Plus className="h-4 w-4 mr-2" />
            Add Repository
          </Button>
        </div>
        <button
          type="button"
          onClick={() => setShowManualUrl(true)}
          className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
        >
          <ChevronDown className="h-3 w-3" />
          Or enter URL manually
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {showCancel && (
        <div className="flex items-center justify-between">
          <Label className="text-sm font-medium">Add Repository</Label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleCancel}
          >
            Cancel
          </Button>
        </div>
      )}
      <Input
        placeholder="https://github.com/org/repo.git"
        value={newRepo.url}
        onChange={(e) => setNewRepo({ ...newRepo, url: e.target.value })}
      />
      <div className="grid grid-cols-2 gap-2">
        <Input
          placeholder="Branch"
          value={newRepo.branch}
          onChange={(e) => setNewRepo({ ...newRepo, branch: e.target.value })}
        />
        <Input
          placeholder="Clone path"
          value={newRepo.clonePath}
          onChange={(e) =>
            setNewRepo({ ...newRepo, clonePath: e.target.value })
          }
        />
      </div>
      <Button
        type="button"
        onClick={handleAdd}
        disabled={!newRepo.url}
        className="w-full"
      >
        <Plus className="h-4 w-4 mr-2" />
        Add Repository
      </Button>
      {isGitHubConnected && (
        <button
          type="button"
          onClick={() => setShowManualUrl(false)}
          className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
        >
          <ChevronUp className="h-3 w-3" />
          Select from GitHub
        </button>
      )}
    </div>
  );
}
