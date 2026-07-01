import { useSuspenseQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { useCreateSandbox, workspaceListQuery } from "@/api/queries";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

export function StartWorkingCard() {
  const { data: workspaces } = useSuspenseQuery(workspaceListQuery());
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>("");
  const [showSuccess, setShowSuccess] = useState(false);

  const createSandbox = useCreateSandbox();

  const handleStart = () => {
    if (!selectedWorkspaceId) return;
    setShowSuccess(false);
    createSandbox.mutate(
      { workspaceId: selectedWorkspaceId, baseImage: "dev-base" },
      {
        onSuccess: () => {
          setSelectedWorkspaceId("");
          setShowSuccess(true);
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg">Start Working</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
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
                      <span className="text-xs text-yellow-600">building</span>
                    )}
                  </div>
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>

        {showSuccess && (
          <div className="p-3 bg-green-500/10 border border-green-500/20 rounded-md text-sm text-green-700 dark:text-green-400">
            Sandbox starting…
          </div>
        )}

        <Button
          onClick={handleStart}
          disabled={!selectedWorkspaceId || createSandbox.isPending}
          className="w-full"
        >
          {createSandbox.isPending && (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          )}
          {createSandbox.isPending ? "Starting..." : "Start Sandbox"}
        </Button>
      </CardContent>
    </Card>
  );
}
