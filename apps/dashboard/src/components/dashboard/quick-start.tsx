import { useQuery } from "@tanstack/react-query";
import { MessageSquare, Plus } from "lucide-react";
import { useState } from "react";
import { workspaceListQuery } from "@/api/queries";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  onCreateTask?: (workspaceId: string, description: string) => void;
  onStartChat?: (workspaceId: string) => void;
  isCreating?: boolean;
}

export function QuickStart({
  onCreateTask,
  onStartChat,
  isCreating,
}: QuickStartProps) {
  const { data: workspaces } = useQuery(workspaceListQuery());
  const [selectedWorkspace, setSelectedWorkspace] = useState<string>("");
  const [taskDescription, setTaskDescription] = useState("");

  const handleCreateTask = () => {
    if (selectedWorkspace && taskDescription.trim() && onCreateTask) {
      onCreateTask(selectedWorkspace, taskDescription.trim());
      setTaskDescription("");
    }
  };

  const handleStartChat = () => {
    if (selectedWorkspace && onStartChat) {
      onStartChat(selectedWorkspace);
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
        <div className="space-y-2">
          <Label htmlFor="quick-start-workspace">Workspace</Label>
          <Select
            value={selectedWorkspace}
            onValueChange={setSelectedWorkspace}
          >
            <SelectTrigger id="quick-start-workspace">
              <SelectValue placeholder="Select a workspace" />
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
          <Label htmlFor="quick-start-description">Describe your task</Label>
          <Textarea
            id="quick-start-description"
            placeholder="What would you like to accomplish?"
            value={taskDescription}
            onChange={(e) => setTaskDescription(e.target.value)}
            rows={3}
          />
        </div>

        <div className="flex gap-2">
          <Button
            onClick={handleCreateTask}
            disabled={
              !selectedWorkspace || !taskDescription.trim() || isCreating
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
