import type { TaskEffort } from "@frak-sandbox/shared/constants";
import { useQuery } from "@tanstack/react-query";
import { MessageSquare, Plus } from "lucide-react";
import { useState } from "react";
import { workspaceListQuery } from "@/api/queries";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

interface QuickStartProps {
  onCreateTask?: (
    workspaceId: string,
    title: string,
    description: string,
    effort: TaskEffort,
  ) => void;
  onStartChat?: (workspaceId: string, effort: TaskEffort) => void;
  isCreating?: boolean;
}

export function QuickStart({
  onCreateTask,
  onStartChat,
  isCreating,
}: QuickStartProps) {
  const { data: workspaces } = useQuery(workspaceListQuery());
  const [selectedWorkspace, setSelectedWorkspace] = useState<string>("");
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDescription, setTaskDescription] = useState("");
  const [selectedEffort, setSelectedEffort] = useState<TaskEffort>("low");

  const handleCreateTask = () => {
    if (
      selectedWorkspace &&
      taskTitle.trim() &&
      taskDescription.trim() &&
      onCreateTask
    ) {
      onCreateTask(
        selectedWorkspace,
        taskTitle.trim(),
        taskDescription.trim(),
        selectedEffort,
      );
      setTaskTitle("");
      setTaskDescription("");
    }
  };

  const handleStartChat = () => {
    if (selectedWorkspace && onStartChat) {
      onStartChat(selectedWorkspace, selectedEffort);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Plus className="h-4 w-4" />
          Quick Start
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor="quick-start-workspace">Workspace</Label>
            <Select
              value={selectedWorkspace}
              onValueChange={setSelectedWorkspace}
            >
              <SelectTrigger id="quick-start-workspace">
                <SelectValue placeholder="Select workspace" />
              </SelectTrigger>
              <SelectContent>
                {workspaces?.map((workspace) => (
                  <SelectItem key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="quick-start-effort">Effort</Label>
            <Select
              value={selectedEffort}
              onValueChange={(v) => setSelectedEffort(v as TaskEffort)}
            >
              <SelectTrigger id="quick-start-effort">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="low">Low (Sonnet)</SelectItem>
                <SelectItem value="medium">Medium (Opus)</SelectItem>
                <SelectItem value="high">High (Opus, Max)</SelectItem>
                <SelectItem value="maximum">Maximum (Opus, Planner)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="quick-start-title">Task Title</Label>
          <Input
            id="quick-start-title"
            placeholder="e.g., Implement user authentication"
            value={taskTitle}
            onChange={(e) => setTaskTitle(e.target.value)}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="quick-start-description">Description</Label>
          <Textarea
            id="quick-start-description"
            placeholder="Describe the task in detail..."
            value={taskDescription}
            onChange={(e) => setTaskDescription(e.target.value)}
            rows={3}
          />
        </div>

        <div className="flex gap-2">
          <Button
            onClick={handleCreateTask}
            disabled={
              !selectedWorkspace ||
              !taskTitle.trim() ||
              !taskDescription.trim() ||
              isCreating
            }
            className="flex-1"
          >
            <Plus className="h-4 w-4 mr-2" />
            Create Task
          </Button>
          <Button
            variant="outline"
            onClick={handleStartChat}
            disabled={!selectedWorkspace}
          >
            <MessageSquare className="h-4 w-4 mr-2" />
            Chat
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
