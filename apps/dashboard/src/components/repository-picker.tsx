import { useQuery } from "@tanstack/react-query";
import { Check, ChevronsUpDown, Github, Lock, Unlock } from "lucide-react";
import { useMemo, useState } from "react";
import type { GitHubRepository } from "@/api/client";
import { githubReposQuery, githubStatusQuery } from "@/api/queries";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { API_URL } from "@/config";
import { cn } from "@/lib/utils";

interface RepositoryPickerProps {
  value?: string;
  onSelect: (repo: {
    cloneUrl: string;
    defaultBranch: string;
    name: string;
    fullName: string;
  }) => void;
}

export function RepositoryPicker({ value, onSelect }: RepositoryPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const { data: status } = useQuery(githubStatusQuery);
  const { data: reposData, isLoading: isLoadingRepos } = useQuery({
    ...githubReposQuery({ perPage: 100 }),
    enabled: status?.connected === true,
  });

  const filteredRepos = useMemo(() => {
    if (!reposData?.repositories) return [];
    if (!search) return reposData.repositories;

    const lowerSearch = search.toLowerCase();
    return reposData.repositories.filter(
      (repo) =>
        repo.name.toLowerCase().includes(lowerSearch) ||
        repo.fullName.toLowerCase().includes(lowerSearch) ||
        repo.description?.toLowerCase().includes(lowerSearch),
    );
  }, [reposData?.repositories, search]);

  if (!status?.connected) {
    return (
      <Button
        variant="outline"
        className="w-full justify-start gap-2 text-muted-foreground"
        onClick={() => {
          window.location.href = `${API_URL}/auth/github/login`;
        }}
      >
        <Github className="h-4 w-4" />
        Connect GitHub to select a repository
      </Button>
    );
  }

  const selectedRepo = reposData?.repositories.find(
    (r) => r.cloneUrl === value,
  );

  return (
    <Popover open={open} onOpenChange={setOpen} modal={false}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between"
        >
          {selectedRepo ? (
            <span className="flex items-center gap-2 truncate">
              {selectedRepo.private ? (
                <Lock className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
              ) : (
                <Unlock className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
              )}
              <span className="truncate">{selectedRepo.fullName}</span>
            </span>
          ) : (
            <span className="text-muted-foreground">
              Select a repository...
            </span>
          )}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[400px] p-0" align="start">
        <div className="p-2 border-b">
          <Input
            placeholder="Search repositories..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8"
          />
        </div>
        <ScrollArea className="h-[300px]">
          {isLoadingRepos ? (
            <div className="p-4 text-center text-sm text-muted-foreground">
              Loading repositories...
            </div>
          ) : filteredRepos.length === 0 ? (
            <div className="p-4 text-center text-sm text-muted-foreground">
              {search ? "No repositories found" : "No repositories available"}
            </div>
          ) : (
            <div className="p-1">
              {filteredRepos.map((repo) => (
                <RepoItem
                  key={repo.id}
                  repo={repo}
                  isSelected={value === repo.cloneUrl}
                  onSelect={() => {
                    onSelect({
                      cloneUrl: repo.cloneUrl,
                      defaultBranch: repo.defaultBranch,
                      name: repo.name,
                      fullName: repo.fullName,
                    });
                    setOpen(false);
                  }}
                />
              ))}
            </div>
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}

function RepoItem({
  repo,
  isSelected,
  onSelect,
}: {
  repo: GitHubRepository;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex items-start gap-2 w-full p-2 rounded-md text-left hover:bg-accent transition-colors",
        isSelected && "bg-accent",
      )}
    >
      <div className="flex-shrink-0 mt-0.5">
        {repo.private ? (
          <Lock className="h-4 w-4 text-amber-500" />
        ) : (
          <Unlock className="h-4 w-4 text-green-500" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm truncate">{repo.fullName}</span>
          {isSelected && (
            <Check className="h-4 w-4 text-primary flex-shrink-0" />
          )}
        </div>
        {repo.description && (
          <p className="text-xs text-muted-foreground truncate mt-0.5">
            {repo.description}
          </p>
        )}
        <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
          {repo.language && <span>{repo.language}</span>}
          <span>Updated {formatDate(repo.updatedAt)}</span>
        </div>
      </div>
    </button>
  );
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)} months ago`;
  return `${Math.floor(diffDays / 365)} years ago`;
}
