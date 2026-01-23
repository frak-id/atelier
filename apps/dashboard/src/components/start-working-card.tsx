import type { Task } from "@frak-sandbox/manager/types";
import type { TaskEffort } from "@frak-sandbox/shared/constants";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  Kanban,
  Loader2,
  MessageSquare,
  Play,
  Plus,
} from "lucide-react";
import { useState } from "react";
import type { Workspace } from "@/api/client";
import {
  taskListQuery,
  useCreateTask,
  workspaceListQuery,
} from "@/api/queries";
import { useStartSession } from "@/hooks/use-start-session";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { Textarea } from "./ui/textarea";

export function StartWorkingCard() {
  const { data: workspaces } = useSuspenseQuery(workspaceListQuery());
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>("");

  const selectedWorkspace = workspaces?.find(
    (w) => w.id === selectedWorkspaceId,
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg">Start Working</CardTitle>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="chat" className="w-full">
          <TabsList className="grid w-full grid-cols-2 mb-4">
            <TabsTrigger value="chat" className="gap-2">
              <MessageSquare className="h-4 w-4" />
              Chat
            </TabsTrigger>
            <TabsTrigger value="task" className="gap-2">
              <Kanban className="h-4 w-4" />
              Task
            </TabsTrigger>
          </TabsList>

          <div className="mb-4">
            <Select
              value={selectedWorkspaceId}
              onValueChange={setSelectedWorkspaceId}
            >
              <SelectTrigger>
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
          </div>

          <TabsContent value="chat">
            <ChatTab
              workspace={selectedWorkspace}
              workspaceId={selectedWorkspaceId}
            />
          </TabsContent>

          <TabsContent value="task">
            <TaskTab
              workspaceId={selectedWorkspaceId}
              hasWorkspace={!!selectedWorkspace}
            />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

type ChatTabProps = {
  workspace: Workspace | undefined;
  workspaceId: string;
};

function ChatTab({ workspace, workspaceId }: ChatTabProps) {
  const [message, setMessage] = useState("");
  const [selectedEffort, setSelectedEffort] = useState<TaskEffort>("low");

  const { mutate, isPending, isSuccess, isError, error, reset } =
    useStartSession();

  const canSubmit = workspace && message.trim().length > 0 && !isPending;

  const handleStartSession = () => {
    if (!workspace || !message.trim()) return;
    mutate({
      workspace,
      message: message.trim(),
      effort: selectedEffort,
    });
  };

  const handleReset = () => {
    reset();
    setMessage("");
    setSelectedEffort("low");
  };

  return (
    <div className="space-y-4">
      {isError && (
        <div className="flex items-start gap-2 p-3 bg-destructive/10 border border-destructive/20 rounded-md text-sm">
          <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
          <div className="space-y-1">
            <p className="text-destructive font-medium">
              {error instanceof Error ? error.message : "Something went wrong"}
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
        disabled={isPending || !workspaceId}
      />

      <div className="flex gap-3">
        <Select
          value={selectedEffort}
          onValueChange={(v) => setSelectedEffort(v as TaskEffort)}
          disabled={isPending}
        >
          <SelectTrigger className="w-[140px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="low">Low</SelectItem>
            <SelectItem value="medium">Medium</SelectItem>
            <SelectItem value="high">High</SelectItem>
            <SelectItem value="maximum">Maximum</SelectItem>
          </SelectContent>
        </Select>

        <Button
          onClick={handleStartSession}
          disabled={!canSubmit}
          className="flex-1"
        >
          {isPending ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Play className="h-4 w-4 mr-2" />
          )}
          {isPending ? "Starting..." : "Start Session"}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        Starts immediately in a new sandbox. Best for quick exploration or
        one-off tasks.
      </p>
    </div>
  );
}

type TaskTabProps = {
  workspaceId: string;
  hasWorkspace: boolean;
};

function TaskTab({ workspaceId, hasWorkspace }: TaskTabProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [selectedEffort, setSelectedEffort] = useState<TaskEffort>("low");

  const createMutation = useCreateTask();

  const { data: tasks } = useQuery({
    ...taskListQuery(workspaceId),
    enabled: !!workspaceId,
  });

  const draftTasks = tasks?.filter((t) => t.status === "draft") ?? [];
  const canSubmit =
    hasWorkspace &&
    title.trim().length > 0 &&
    description.trim().length > 0 &&
    !createMutation.isPending;

  const handleCreateTask = async () => {
    if (!canSubmit) return;

    await createMutation.mutateAsync({
      workspaceId,
      title: title.trim(),
      description: description.trim(),
      effort: selectedEffort,
    });

    setTitle("");
    setDescription("");
    setSelectedEffort("low");
  };

  return (
    <div className="space-y-4">
      {createMutation.isSuccess && (
        <div className="flex items-center justify-between p-3 bg-green-500/10 border border-green-500/20 rounded-md text-sm">
          <p className="text-green-700 dark:text-green-400">
            Task created! Find it in the Tasks board.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => createMutation.reset()}
            className="h-7 text-xs"
          >
            Dismiss
          </Button>
        </div>
      )}

      {createMutation.isError && (
        <div className="flex items-start gap-2 p-3 bg-destructive/10 border border-destructive/20 rounded-md text-sm">
          <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
          <div className="space-y-1">
            <p className="text-destructive font-medium">
              {createMutation.error instanceof Error
                ? createMutation.error.message
                : "Failed to create task"}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => createMutation.reset()}
              className="h-7 text-xs"
            >
              Dismiss
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="task-title">Title</Label>
          <Input
            id="task-title"
            placeholder="e.g., Add user authentication"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={!hasWorkspace || createMutation.isPending}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="task-description">Description</Label>
          <Textarea
            id="task-description"
            placeholder="Describe what you want the AI to work on..."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="min-h-[80px] resize-none"
            disabled={!hasWorkspace || createMutation.isPending}
          />
        </div>

        <div className="flex gap-3">
          <Select
            value={selectedEffort}
            onValueChange={(v) => setSelectedEffort(v as TaskEffort)}
            disabled={createMutation.isPending}
          >
            <SelectTrigger className="w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="low">Low</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="high">High</SelectItem>
              <SelectItem value="maximum">Maximum</SelectItem>
            </SelectContent>
          </Select>

          <Button
            onClick={handleCreateTask}
            disabled={!canSubmit}
            className="flex-1"
          >
            {createMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Plus className="h-4 w-4 mr-2" />
            )}
            {createMutation.isPending ? "Creating..." : "Create Task"}
          </Button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Creates a draft task. Start it from the Tasks board when ready.
      </p>

      {draftTasks.length > 0 && (
        <div className="pt-2 border-t">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium">Draft Tasks</span>
            <Badge variant="secondary" className="text-xs">
              {draftTasks.length}
            </Badge>
          </div>
          <div className="space-y-1.5">
            {draftTasks.slice(0, 3).map((task) => (
              <DraftTaskItem key={task.id} task={task} />
            ))}
            {draftTasks.length > 3 && (
              <a
                href="/tasks"
                className="block text-xs text-muted-foreground hover:text-foreground text-center pt-1"
              >
                +{draftTasks.length - 3} more in Tasks board
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function DraftTaskItem({ task }: { task: Task }) {
  return (
    <a
      href="/tasks"
      className="flex items-center gap-2 p-2 rounded-md hover:bg-accent transition-colors group"
    >
      <div className="h-2 w-2 rounded-full bg-muted-foreground/30" />
      <span className="text-sm truncate flex-1">{task.title}</span>
      <Badge variant="outline" className="text-xs shrink-0">
        {task.data.effort ?? "low"}
      </Badge>
    </a>
  );
}
