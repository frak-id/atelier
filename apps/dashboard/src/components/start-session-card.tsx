import { useSuspenseQuery } from "@tanstack/react-query";
import { AlertCircle, Loader2, Play } from "lucide-react";
import { useState } from "react";
import { workspaceListQuery } from "@/api/queries";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useStartSession } from "@/hooks/use-start-session";

export function StartSessionCard() {
  const { data: workspaces } = useSuspenseQuery(workspaceListQuery());
  const [message, setMessage] = useState("");
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>("");

  const { mutate, isPending, isSuccess, isError, error, reset } =
    useStartSession();

  const selectedWorkspace = workspaces?.find(
    (w) => w.id === selectedWorkspaceId,
  );
  const canSubmit =
    selectedWorkspace && message.trim().length > 0 && !isPending;

  const handleStartSession = () => {
    if (!selectedWorkspace || !message.trim()) return;
    mutate({ workspace: selectedWorkspace, message: message.trim() });
  };

  const handleReset = () => {
    reset();
    setMessage("");
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg">Start a Session</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {isError && (
          <div className="flex items-start gap-2 p-3 bg-destructive/10 border border-destructive/20 rounded-md text-sm">
            <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
            <div className="space-y-1">
              <p className="text-destructive font-medium">
                {error instanceof Error
                  ? error.message
                  : "Something went wrong"}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={handleReset}
                className="h-7 text-xs"
              >
                Try again
              </Button>
            </div>
          </div>
        )}

        {isSuccess && (
          <div className="flex items-center justify-between p-3 bg-green-500/10 border border-green-500/20 rounded-md text-sm">
            <p className="text-green-700 dark:text-green-400">
              Session started! Check your new browser tab.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={handleReset}
              className="h-7 text-xs"
            >
              Start another
            </Button>
          </div>
        )}

        {isPending && (
          <div className="flex items-center gap-2 p-3 bg-muted rounded-md text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Starting session...</span>
          </div>
        )}

        <Textarea
          placeholder="What do you want to work on?"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          className="min-h-[100px] resize-none"
          disabled={isPending}
        />

        <div className="flex flex-col sm:flex-row gap-3">
          <Select
            value={selectedWorkspaceId}
            onValueChange={setSelectedWorkspaceId}
            disabled={isPending}
          >
            <SelectTrigger className="flex-1">
              <SelectValue placeholder="Select workspace..." />
            </SelectTrigger>
            <SelectContent>
              {workspaces?.length === 0 ? (
                <div className="px-2 py-4 text-sm text-muted-foreground text-center">
                  No workspaces available.
                  <br />
                  Create one in the Workspaces tab.
                </div>
              ) : (
                workspaces?.map((workspace) => (
                  <SelectItem key={workspace.id} value={workspace.id}>
                    <div className="flex items-center gap-2">
                      <span>{workspace.name}</span>
                      {workspace.config.prebuild?.status === "ready" && (
                        <span className="text-xs text-green-600">ready</span>
                      )}
                      {workspace.config.prebuild?.status === "building" && (
                        <span className="text-xs text-yellow-600">
                          building
                        </span>
                      )}
                    </div>
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>

          <Button
            onClick={handleStartSession}
            disabled={!canSubmit}
            className="sm:w-auto"
          >
            {isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Play className="h-4 w-4 mr-2" />
            )}
            {isPending ? "Starting..." : "Start Session"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
