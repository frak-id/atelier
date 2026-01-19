import { useSuspenseQuery } from "@tanstack/react-query";
import { Play } from "lucide-react";
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

export function StartSessionCard() {
  const { data: workspaces } = useSuspenseQuery(workspaceListQuery());
  const [message, setMessage] = useState("");
  const [selectedWorkspace, setSelectedWorkspace] = useState<string>("");

  const handleStartSession = () => {
    if (!selectedWorkspace || !message.trim()) return;

    console.log("Starting session:", {
      workspaceId: selectedWorkspace,
      message: message.trim(),
    });

    alert(
      `TODO: Start session\nWorkspace: ${selectedWorkspace}\nMessage: ${message.trim()}`,
    );
  };

  const canSubmit = selectedWorkspace && message.trim().length > 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg">Start a Session</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Textarea
          placeholder="What do you want to work on?"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          className="min-h-[100px] resize-none"
        />

        <div className="flex flex-col sm:flex-row gap-3">
          <Select
            value={selectedWorkspace}
            onValueChange={setSelectedWorkspace}
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
            <Play className="h-4 w-4 mr-2" />
            Start Session
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
