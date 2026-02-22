import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  GitBranch,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  sandboxGitDiffQuery,
  sandboxGitStatusQuery,
  useGitCommit,
  useGitPush,
} from "@/api/queries";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function RepositoriesTab({ sandboxId }: { sandboxId: string }) {
  const { data, isLoading, refetch } = useQuery(
    sandboxGitStatusQuery(sandboxId),
  );

  const repos = data?.repos ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between py-4">
        <CardTitle className="text-base flex items-center gap-2">
          <GitBranch className="h-4 w-4" />
          Repositories
        </CardTitle>
        <Button variant="ghost" size="sm" onClick={() => refetch()}>
          <RefreshCw className="h-3.5 w-3.5 mr-1" />
          Refresh
        </Button>
      </CardHeader>
      <CardContent className="pt-0">
        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading repositories...
          </div>
        ) : repos.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <GitBranch className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">No repositories configured</p>
          </div>
        ) : (
          <div className="space-y-3">
            {repos.map((repo) => (
              <RepoRow key={repo.path} sandboxId={sandboxId} repo={repo} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RepoRow({
  sandboxId,
  repo,
}: {
  sandboxId: string;
  repo: {
    path: string;
    branch: string | null;
    lastCommit: string | null;
    dirty: boolean;
    ahead: number;
    behind: number;
    error?: string;
  };
}) {
  const [expanded, setExpanded] = useState(false);
  const diffQuery = useQuery({
    ...sandboxGitDiffQuery(sandboxId),
    enabled: expanded,
  });

  const repoDiff = diffQuery.data?.repos?.find(
    (r: { path: string }) => r.path === repo.path,
  );

  return (
    <div className="rounded-lg border overflow-hidden">
      <button
        type="button"
        className="w-full flex items-start justify-between p-3 bg-muted/30 hover:bg-muted/50 transition-colors cursor-pointer text-left"
        onClick={() => {
          setExpanded(!expanded);
          if (!expanded && !diffQuery.data) {
            diffQuery.refetch();
          }
        }}
      >
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {expanded ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <div className="flex-1 min-w-0">
            <div className="font-mono text-sm font-medium truncate">
              {repo.path}
            </div>
            {repo.error ? (
              <div className="text-xs text-destructive mt-1">{repo.error}</div>
            ) : (
              <div className="flex flex-col gap-1 mt-1.5 min-w-0">
                {repo.branch && (
                  <div className="flex items-center gap-1 text-xs min-w-0">
                    <GitBranch className="h-3 w-3 text-muted-foreground shrink-0" />
                    <span className="font-mono truncate">{repo.branch}</span>
                  </div>
                )}
                {repo.lastCommit && (
                  <span
                    className="text-xs text-muted-foreground truncate"
                    title={repo.lastCommit}
                  >
                    {repo.lastCommit}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1.5 ml-3">
          {repo.dirty && (
            <Badge variant="warning" className="text-[10px] h-5 px-1.5">
              Dirty
            </Badge>
          )}
          {repo.ahead > 0 && (
            <Badge variant="secondary" className="text-[10px] h-5 px-1.5">
              +{repo.ahead}
            </Badge>
          )}
          {repo.behind > 0 && (
            <Badge variant="secondary" className="text-[10px] h-5 px-1.5">
              -{repo.behind}
            </Badge>
          )}
          {!repo.error && !repo.dirty && repo.ahead === 0 && (
            <Badge variant="success" className="text-[10px] h-5 px-1.5">
              Clean
            </Badge>
          )}
        </div>
      </button>

      {expanded && (
        <div className="border-t p-3 space-y-3">
          {diffQuery.isLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground py-4 justify-center">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading diff...
            </div>
          ) : repoDiff && repoDiff.files.length > 0 ? (
            <div className="space-y-1">
              {repoDiff.files.map(
                (file: {
                  path: string;
                  added: number;
                  removed: number;
                  status?: string;
                }) => (
                  <div
                    key={file.path}
                    className="flex items-center justify-between px-2 py-1 rounded text-xs font-mono bg-muted/40"
                  >
                    <span className="truncate flex-1 min-w-0">{file.path}</span>
                    <div className="flex items-center gap-2 ml-2 shrink-0">
                      {file.status === "untracked" ? (
                        <Badge
                          variant="outline"
                          className="text-[9px] h-4 px-1"
                        >
                          new
                        </Badge>
                      ) : (
                        <>
                          {file.added > 0 && (
                            <span className="text-green-500">
                              +{file.added}
                            </span>
                          )}
                          {file.removed > 0 && (
                            <span className="text-red-500">
                              -{file.removed}
                            </span>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                ),
              )}
              <div className="flex items-center gap-3 text-xs text-muted-foreground pt-1 px-2">
                <span className="text-green-500">+{repoDiff.totalAdded}</span>
                <span className="text-red-500">-{repoDiff.totalRemoved}</span>
                <span>
                  {repoDiff.files.length} file
                  {repoDiff.files.length !== 1 ? "s" : ""} changed
                </span>
              </div>
            </div>
          ) : (
            <div className="text-xs text-muted-foreground text-center py-2">
              Working tree clean
            </div>
          )}

          {(repo.dirty || repo.ahead > 0) && (
            <RepoCommitForm
              sandboxId={sandboxId}
              repoPath={repo.path}
              isDirty={repo.dirty}
              ahead={repo.ahead}
              onDiffRefetch={() => diffQuery.refetch()}
            />
          )}
        </div>
      )}
    </div>
  );
}

function RepoCommitForm({
  sandboxId,
  repoPath,
  isDirty,
  ahead,
  onDiffRefetch,
}: {
  sandboxId: string;
  repoPath: string;
  isDirty: boolean;
  ahead: number;
  onDiffRefetch: () => void;
}) {
  const [message, setMessage] = useState("");
  const commitMutation = useGitCommit(sandboxId);
  const pushMutation = useGitPush(sandboxId);
  const [commitAndPushing, setCommitAndPushing] = useState(false);

  const isAnyLoading =
    commitMutation.isPending || pushMutation.isPending || commitAndPushing;

  const handleCommit = () => {
    commitMutation.mutate(
      { repoPath, message },
      {
        onSuccess: (result) => {
          if (!result) return toast.error("Commit failed");
          if (result.success) {
            toast.success(`Committed: ${result.hash?.slice(0, 7) ?? "ok"}`);
            setMessage("");
            onDiffRefetch();
          } else {
            toast.error(result.error ?? "Commit failed");
          }
        },
        onError: () => toast.error("Commit failed"),
      },
    );
  };

  const handlePush = () => {
    pushMutation.mutate(repoPath, {
      onSuccess: (result) => {
        if (!result) return toast.error("Push failed");
        if (result.success) {
          toast.success("Pushed successfully");
        } else {
          toast.error(result.error ?? "Push failed");
        }
      },
      onError: () => toast.error("Push failed"),
    });
  };

  const handleCommitAndPush = async () => {
    setCommitAndPushing(true);
    try {
      const commitResult = await commitMutation.mutateAsync({
        repoPath,
        message,
      });
      if (!commitResult?.success) {
        toast.error(commitResult?.error ?? "Commit failed");
        return;
      }
      toast.success(`Committed: ${commitResult.hash?.slice(0, 7) ?? "ok"}`);

      const pushResult = await pushMutation.mutateAsync(repoPath);
      if (!pushResult?.success) {
        toast.error(pushResult?.error ?? "Push failed");
        return;
      }
      toast.success("Pushed successfully");
      setMessage("");
      onDiffRefetch();
    } catch {
      toast.error("Commit & push failed");
    } finally {
      setCommitAndPushing(false);
    }
  };

  return (
    <div className="border-t pt-3 space-y-2">
      {isDirty && (
        <input
          type="text"
          className="w-full rounded-md border bg-background px-3 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          placeholder="Commit message..."
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && message.trim()) handleCommit();
          }}
          disabled={isAnyLoading}
        />
      )}
      <div className="flex items-center gap-2">
        {isDirty && (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={!message.trim() || isAnyLoading}
              onClick={handleCommit}
            >
              {commitMutation.isPending && (
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
              )}
              Commit
            </Button>
            <Button
              size="sm"
              disabled={!message.trim() || isAnyLoading}
              onClick={handleCommitAndPush}
            >
              {commitAndPushing && (
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
              )}
              Commit & Push
            </Button>
          </>
        )}
        {ahead > 0 && (
          <Button
            size="sm"
            variant={isDirty ? "outline" : "default"}
            disabled={isAnyLoading}
            onClick={handlePush}
          >
            {pushMutation.isPending && (
              <Loader2 className="h-3 w-3 animate-spin mr-1" />
            )}
            Push ({ahead})
          </Button>
        )}
      </div>
    </div>
  );
}
