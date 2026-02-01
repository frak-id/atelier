import type { SessionTemplate } from "@frak-sandbox/shared/constants";
import { DEFAULT_SESSION_TEMPLATES } from "@frak-sandbox/shared/constants";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  Kanban,
  Loader2,
  MessageSquare,
  Play,
} from "lucide-react";
import { useState } from "react";
import type { Workspace } from "@/api/client";
import {
  workspaceListQuery,
  workspaceSessionTemplatesQuery,
} from "@/api/queries";
import { TaskForm } from "@/components/kanban/task-form-dialog";
import { useStartSession } from "@/hooks/use-start-session";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
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

  const { data: templateData } = useQuery({
    ...workspaceSessionTemplatesQuery(selectedWorkspaceId),
    enabled: !!selectedWorkspaceId,
  });
  const templates = templateData?.templates ?? DEFAULT_SESSION_TEMPLATES;

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
              templates={templates}
            />
          </TabsContent>

          <TabsContent value="task">
            <TaskTab workspaceId={selectedWorkspaceId} />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

type ChatTabProps = {
  workspace: Workspace | undefined;
  workspaceId: string;
  templates: SessionTemplate[];
};

function ChatTab({ workspace, workspaceId, templates }: ChatTabProps) {
  const [message, setMessage] = useState("");
  const defaultTemplate = templates[0];
  const [selectedTemplateId, setSelectedTemplateId] = useState(
    defaultTemplate?.id ?? "",
  );
  const [selectedVariantIndex, setSelectedVariantIndex] = useState(
    defaultTemplate?.defaultVariantIndex ?? 0,
  );

  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId);
  const selectedVariant = selectedTemplate?.variants[selectedVariantIndex];

  const { mutate, isPending, isSuccess, isError, error, reset } =
    useStartSession();

  const canSubmit = workspace && message.trim().length > 0 && !isPending;

  const handleStartSession = () => {
    if (!workspace || !message.trim()) return;
    mutate({
      workspace,
      message: message.trim(),
      templateConfig: selectedVariant
        ? {
            model: selectedVariant.model,
            variant: selectedVariant.variant,
            agent: selectedVariant.agent,
          }
        : undefined,
    });
  };

  const handleReset = () => {
    reset();
    setMessage("");
    setSelectedTemplateId(defaultTemplate?.id ?? "");
    setSelectedVariantIndex(defaultTemplate?.defaultVariantIndex ?? 0);
  };

  const handleTemplateChange = (templateId: string) => {
    setSelectedTemplateId(templateId);
    const template = templates.find((t) => t.id === templateId);
    setSelectedVariantIndex(template?.defaultVariantIndex ?? 0);
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

      <div className="flex flex-wrap gap-3">
        {templates.length > 1 && (
          <Select
            value={selectedTemplateId}
            onValueChange={handleTemplateChange}
            disabled={isPending}
          >
            <SelectTrigger className="w-full sm:w-[140px]">
              <SelectValue placeholder="Template" />
            </SelectTrigger>
            <SelectContent>
              {templates.map((template) => (
                <SelectItem key={template.id} value={template.id}>
                  {template.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {selectedTemplate && selectedTemplate.variants.length > 0 && (
          <Select
            value={String(selectedVariantIndex)}
            onValueChange={(v) => setSelectedVariantIndex(Number(v))}
            disabled={isPending}
          >
            <SelectTrigger className="w-full sm:w-[140px]">
              <SelectValue placeholder="Effort" />
            </SelectTrigger>
            <SelectContent>
              {selectedTemplate.variants.map((variant, idx) => (
                <SelectItem key={idx} value={String(idx)}>
                  {variant.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <Button
          onClick={handleStartSession}
          disabled={!canSubmit}
          className="w-full sm:flex-1"
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

function TaskTab({ workspaceId }: { workspaceId: string }) {
  return (
    <div className="space-y-4">
      <TaskForm
        workspaceId={workspaceId || undefined}
        showWorkspaceSelector={false}
      />
      <p className="text-xs text-muted-foreground">
        Creates a draft task. Start it from the Tasks board when ready.
      </p>
    </div>
  );
}
