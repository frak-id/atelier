import type { TaskTemplate } from "@frak-sandbox/shared/constants";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { useRef, useState } from "react";
import type { ConfigFile, ConfigFileContentType, Sandbox } from "@/api/client";
import {
  configFilesListQuery,
  globalTaskTemplatesQuery,
  sandboxListQuery,
  sharedAuthListQuery,
  useCreateConfigFile,
  useDeleteConfigFile,
  useRestartSandbox,
  useSyncConfigsToNfs,
  useUpdateConfigFile,
  useUpdateGlobalTaskTemplates,
  useUpdateSharedAuth,
  workspaceListQuery,
} from "@/api/queries";
import { SshKeysSection } from "@/components/ssh-keys-section";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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

export const Route = createFileRoute("/settings/")({
  component: SettingsPage,
});

function SettingsPage() {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showRestartDialog, setShowRestartDialog] = useState(false);
  const [selectedSandboxes, setSelectedSandboxes] = useState<string[]>([]);

  const { data: globalConfigs, isLoading: loadingGlobal } = useQuery(
    configFilesListQuery({ scope: "global" }),
  );

  const { data: workspaces } = useQuery(workspaceListQuery());

  const { data: allWorkspaceConfigs } = useQuery(
    configFilesListQuery({ scope: "workspace" }),
  );

  const { data: sandboxes } = useQuery(sandboxListQuery({ status: "running" }));

  const createMutation = useCreateConfigFile();
  const updateMutation = useUpdateConfigFile();
  const deleteMutation = useDeleteConfigFile();
  const syncMutation = useSyncConfigsToNfs();
  const restartMutation = useRestartSandbox();

  const runningSandboxes = sandboxes ?? [];

  const handleConfigChange = () => {
    syncMutation.mutate(undefined, {
      onSuccess: () => {
        if (runningSandboxes.length > 0) {
          setSelectedSandboxes(runningSandboxes.map((s) => s.id));
          setShowRestartDialog(true);
        }
      },
    });
  };

  const handleRestartSelected = async () => {
    for (const id of selectedSandboxes) {
      await restartMutation.mutateAsync(id);
    }
    setShowRestartDialog(false);
    setSelectedSandboxes([]);
  };

  const workspaceConfigCounts = new Map<string, number>();
  allWorkspaceConfigs?.forEach((c: ConfigFile) => {
    if (c.workspaceId) {
      workspaceConfigCounts.set(
        c.workspaceId,
        (workspaceConfigCounts.get(c.workspaceId) ?? 0) + 1,
      );
    }
  });

  if (loadingGlobal) {
    return (
      <div className="p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 w-48 bg-muted rounded" />
          <div className="h-64 bg-muted rounded" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <SshKeysSection />

      <div className="border-t pt-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Global Config Files</h1>
            <p className="text-muted-foreground">
              Configuration files injected into all sandboxes
            </p>
          </div>
          <Button
            variant="outline"
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending}
          >
            {syncMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-2" />
            )}
            Sync to NFS
          </Button>
        </div>
      </div>

      <AddConfigFileDialog
        onAdd={(data) =>
          createMutation.mutate(
            { ...data, scope: "global" as const },
            { onSuccess: handleConfigChange },
          )
        }
        isPending={createMutation.isPending}
      />

      <RestartSandboxesDialog
        open={showRestartDialog}
        onOpenChange={setShowRestartDialog}
        sandboxes={runningSandboxes}
        selectedIds={selectedSandboxes}
        onSelectedChange={setSelectedSandboxes}
        onConfirm={handleRestartSelected}
        isRestarting={restartMutation.isPending}
      />

      <div className="space-y-4">
        {globalConfigs?.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-muted-foreground">
              No global config files. Click "Add Config File" to create one.
            </CardContent>
          </Card>
        ) : (
          globalConfigs?.map((config: ConfigFile) => (
            <ConfigFileCard
              key={config.id}
              config={config}
              isEditing={editingId === config.id}
              onEdit={() => setEditingId(config.id)}
              onSave={(content) =>
                updateMutation.mutate(
                  { id: config.id, data: { content } },
                  {
                    onSuccess: () => {
                      setEditingId(null);
                      handleConfigChange();
                    },
                  },
                )
              }
              onCancel={() => setEditingId(null)}
              onDelete={() => {
                if (confirm(`Delete config file ${config.path}?`)) {
                  deleteMutation.mutate(config.id, {
                    onSuccess: handleConfigChange,
                  });
                }
              }}
              isSaving={updateMutation.isPending}
            />
          ))
        )}
      </div>

      <div className="border-t pt-6">
        <h2 className="text-xl font-bold mb-4">Workspace Config Overrides</h2>
        {!workspaces || workspaces.length === 0 ? (
          <p className="text-muted-foreground">No workspaces yet.</p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {workspaces.map((workspace) => {
              const count = workspaceConfigCounts.get(workspace.id) ?? 0;
              return (
                <Card key={workspace.id}>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex items-center justify-between">
                      {workspace.name}
                      <Link to="/workspaces/$id" params={{ id: workspace.id }}>
                        <Button variant="ghost" size="sm">
                          <ExternalLink className="h-4 w-4" />
                        </Button>
                      </Link>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground">
                      {count === 0
                        ? "No config overrides"
                        : `${count} config file${count > 1 ? "s" : ""}`}
                    </p>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      <SharedAuthSection />

      <TaskTemplatesSection />
    </div>
  );
}

function AddConfigFileDialog({
  onAdd,
  isPending,
}: {
  onAdd: (data: {
    path: string;
    content: string;
    contentType: ConfigFileContentType;
  }) => void;
  isPending: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [path, setPath] = useState("");
  const [contentType, setContentType] = useState<ConfigFileContentType>("json");
  const [content, setContent] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = () => {
    if (!path.trim()) return;
    onAdd({
      path: path.trim(),
      content: content || (contentType === "json" ? "{}" : ""),
      contentType,
    });
    setPath("");
    setContent("");
    setIsOpen(false);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    if (contentType === "binary") {
      reader.onload = () => {
        const base64 = (reader.result as string).split(",")[1] ?? "";
        setContent(base64);
      };
      reader.readAsDataURL(file);
    } else {
      reader.onload = () => {
        setContent(reader.result as string);
      };
      reader.readAsText(file);
    }
  };

  if (!isOpen) {
    return (
      <Button onClick={() => setIsOpen(true)}>
        <Plus className="h-4 w-4 mr-2" />
        Add Global Config File
      </Button>
    );
  }

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>Add Global Config File</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label>File Path</Label>
          <Input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="~/.local/share/opencode/auth.json"
          />
          <p className="text-xs text-muted-foreground">
            Use ~ for home directory (/home/dev)
          </p>
        </div>

        <div className="space-y-2">
          <Label>Content Type</Label>
          <Select
            value={contentType}
            onValueChange={(v) => setContentType(v as ConfigFileContentType)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="json">JSON</SelectItem>
              <SelectItem value="text">Text</SelectItem>
              <SelectItem value="binary">Binary (base64)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label>Content</Label>
          {contentType === "binary" ? (
            <div className="flex items-center gap-2">
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileUpload}
                className="hidden"
              />
              <Button
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload className="h-4 w-4 mr-2" />
                Upload File
              </Button>
              {content && (
                <span className="text-sm text-muted-foreground">
                  {Math.round(content.length * 0.75)} bytes
                </span>
              )}
            </div>
          ) : (
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="font-mono text-sm min-h-[200px]"
              placeholder={contentType === "json" ? "{}" : ""}
            />
          )}
        </div>

        <div className="flex gap-2">
          <Button onClick={handleSubmit} disabled={isPending || !path.trim()}>
            {isPending ? "Creating..." : "Create"}
          </Button>
          <Button variant="outline" onClick={() => setIsOpen(false)}>
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function RestartSandboxesDialog({
  open,
  onOpenChange,
  sandboxes,
  selectedIds,
  onSelectedChange,
  onConfirm,
  isRestarting,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sandboxes: Sandbox[];
  selectedIds: string[];
  onSelectedChange: (ids: string[]) => void;
  onConfirm: () => void;
  isRestarting: boolean;
}) {
  const toggleSandbox = (id: string) => {
    if (selectedIds.includes(id)) {
      onSelectedChange(selectedIds.filter((s) => s !== id));
    } else {
      onSelectedChange([...selectedIds, id]);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Config Updated - Restart Sandboxes?</DialogTitle>
          <DialogDescription>
            Config files have been synced to NFS. Running sandboxes need to be
            restarted to pick up the changes.
          </DialogDescription>
        </DialogHeader>

        {sandboxes.length > 0 && (
          <div className="space-y-2 max-h-48 overflow-auto">
            {sandboxes.map((sandbox) => (
              <div key={sandbox.id} className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  id={sandbox.id}
                  checked={selectedIds.includes(sandbox.id)}
                  onChange={() => toggleSandbox(sandbox.id)}
                  className="h-4 w-4 rounded border-gray-300"
                />
                <label
                  htmlFor={sandbox.id}
                  className="text-sm font-medium leading-none cursor-pointer"
                >
                  {sandbox.id}
                  {sandbox.workspaceId && (
                    <span className="text-muted-foreground ml-2">
                      (workspace)
                    </span>
                  )}
                </label>
              </div>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Skip
          </Button>
          <Button
            onClick={onConfirm}
            disabled={isRestarting || selectedIds.length === 0}
          >
            {isRestarting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Restarting...
              </>
            ) : (
              <>
                <RefreshCw className="h-4 w-4 mr-2" />
                Restart {selectedIds.length} Sandbox
                {selectedIds.length !== 1 ? "es" : ""}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConfigFileCard({
  config,
  isEditing,
  onEdit,
  onSave,
  onCancel,
  onDelete,
  isSaving,
}: {
  config: ConfigFile;
  isEditing: boolean;
  onEdit: () => void;
  onSave: (content: string) => void;
  onCancel: () => void;
  onDelete: () => void;
  isSaving: boolean;
}) {
  const [editContent, setEditContent] = useState(config.content);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDownload = () => {
    const filename = config.path.split("/").pop() ?? "config";
    let blob: Blob;

    if (config.contentType === "binary") {
      const binary = atob(config.content);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      blob = new Blob([bytes]);
    } else {
      blob = new Blob([config.content], { type: "text/plain" });
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    if (config.contentType === "binary") {
      reader.onload = () => {
        const base64 = (reader.result as string).split(",")[1] ?? "";
        setEditContent(base64);
      };
      reader.readAsDataURL(file);
    } else {
      reader.onload = () => {
        setEditContent(reader.result as string);
      };
      reader.readAsText(file);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <div>
          <CardTitle className="text-base font-mono">{config.path}</CardTitle>
          <p className="text-xs text-muted-foreground">{config.contentType}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={handleDownload}>
            <Download className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" onClick={onDelete}>
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isEditing ? (
          <div className="space-y-4">
            {config.contentType === "binary" ? (
              <div className="flex items-center gap-2">
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleFileUpload}
                  className="hidden"
                />
                <Button
                  variant="outline"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload className="h-4 w-4 mr-2" />
                  Upload New File
                </Button>
                <span className="text-sm text-muted-foreground">
                  {Math.round(editContent.length * 0.75)} bytes
                </span>
              </div>
            ) : (
              <Textarea
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                className="font-mono text-sm min-h-[200px]"
              />
            )}
            <div className="flex gap-2">
              <Button
                onClick={() => onSave(editContent)}
                disabled={isSaving}
                size="sm"
              >
                {isSaving ? "Saving..." : "Save"}
              </Button>
              <Button variant="outline" onClick={onCancel} size="sm">
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={onEdit}
            className="w-full text-left cursor-pointer hover:bg-muted/50 rounded p-2 -m-2"
          >
            {config.contentType === "binary" ? (
              <p className="text-sm text-muted-foreground">
                Binary file ({Math.round(config.content.length * 0.75)} bytes) -
                click to edit
              </p>
            ) : (
              <pre className="text-sm font-mono whitespace-pre-wrap max-h-[200px] overflow-auto">
                {config.content.slice(0, 1000)}
                {config.content.length > 1000 && "..."}
              </pre>
            )}
          </button>
        )}
        <p className="text-xs text-muted-foreground mt-2">
          Updated: {new Date(config.updatedAt).toLocaleString()}
        </p>
      </CardContent>
    </Card>
  );
}

function SharedAuthSection() {
  const { data: authProviders, isLoading } = useQuery(sharedAuthListQuery);
  const updateMutation = useUpdateSharedAuth();
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");

  if (isLoading) {
    return (
      <div className="border-t pt-6">
        <h2 className="text-xl font-bold mb-4">Shared Auth</h2>
        <div className="animate-pulse h-32 bg-muted rounded" />
      </div>
    );
  }

  const startEdit = (provider: string, content: string | null) => {
    setEditingProvider(provider);
    setEditContent(content ?? "");
  };

  const saveEdit = () => {
    if (!editingProvider) return;
    updateMutation.mutate(
      { provider: editingProvider, content: editContent },
      { onSuccess: () => setEditingProvider(null) },
    );
  };

  return (
    <div className="border-t pt-6">
      <div className="mb-4">
        <h2 className="text-xl font-bold">Shared Auth</h2>
        <p className="text-muted-foreground text-sm">
          Authentication files synced across all sandboxes. Changes here
          propagate to running sandboxes within seconds.
        </p>
      </div>

      <div className="space-y-4">
        {authProviders?.map((auth) => (
          <Card key={auth.provider}>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center justify-between">
                <div>
                  <span className="font-mono">{auth.provider}</span>
                  <p className="text-xs text-muted-foreground font-normal mt-1">
                    {auth.path}
                  </p>
                </div>
                {auth.updatedAt && (
                  <span className="text-xs text-muted-foreground font-normal">
                    Updated {new Date(auth.updatedAt).toLocaleString()}
                    {auth.updatedBy && ` by ${auth.updatedBy}`}
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground mb-3">
                {auth.description}
              </p>

              {editingProvider === auth.provider ? (
                <div className="space-y-4">
                  <Textarea
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    className="font-mono text-sm min-h-[200px]"
                    placeholder="{}"
                  />
                  <div className="flex gap-2">
                    <Button
                      onClick={saveEdit}
                      disabled={updateMutation.isPending}
                      size="sm"
                    >
                      {updateMutation.isPending ? "Saving..." : "Save"}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => setEditingProvider(null)}
                      size="sm"
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => startEdit(auth.provider, auth.content)}
                  className="w-full text-left cursor-pointer hover:bg-muted/50 rounded p-2 -m-2"
                >
                  {auth.content ? (
                    <pre className="text-sm font-mono whitespace-pre-wrap max-h-[150px] overflow-auto">
                      {auth.content.slice(0, 500)}
                      {auth.content.length > 500 && "..."}
                    </pre>
                  ) : (
                    <p className="text-sm text-muted-foreground italic">
                      No auth configured yet. Click to add.
                    </p>
                  )}
                </button>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function TaskTemplatesSection() {
  const { data, isLoading } = useQuery(globalTaskTemplatesQuery);
  const updateMutation = useUpdateGlobalTaskTemplates();
  const [editingTemplate, setEditingTemplate] = useState<TaskTemplate | null>(
    null,
  );
  const [expandedTemplates, setExpandedTemplates] = useState<Set<string>>(
    new Set(),
  );

  if (isLoading) {
    return (
      <div className="border-t pt-6">
        <h2 className="text-xl font-bold mb-4">Task Templates</h2>
        <div className="animate-pulse h-32 bg-muted rounded" />
      </div>
    );
  }

  const templates = data?.templates ?? [];

  const toggleExpanded = (id: string) => {
    setExpandedTemplates((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleSaveTemplate = (updated: TaskTemplate) => {
    const newTemplates = templates.map((t) =>
      t.id === updated.id ? updated : t,
    );
    updateMutation.mutate(newTemplates, {
      onSuccess: () => setEditingTemplate(null),
    });
  };

  const handleDeleteTemplate = (id: string) => {
    if (!confirm("Delete this template?")) return;
    const newTemplates = templates.filter((t) => t.id !== id);
    updateMutation.mutate(newTemplates);
  };

  const handleAddTemplate = () => {
    const newTemplate: TaskTemplate = {
      id: `template-${Date.now()}`,
      name: "New Template",
      description: "",
      variants: [
        {
          name: "Default",
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
          variant: "high",
          agent: "Sisyphus",
        },
      ],
      defaultVariantIndex: 0,
    };
    setEditingTemplate(newTemplate);
  };

  return (
    <div className="border-t pt-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-xl font-bold">Task Templates</h2>
          <p className="text-muted-foreground text-sm">
            Configure AI model and agent settings for tasks
          </p>
        </div>
        <Button onClick={handleAddTemplate}>
          <Plus className="h-4 w-4 mr-2" />
          Add Template
        </Button>
      </div>

      {templates.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            No task templates configured. Using system defaults.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {templates.map((template) => {
            const isExpanded = expandedTemplates.has(template.id);
            return (
              <Card key={template.id}>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <button
                      type="button"
                      onClick={() => toggleExpanded(template.id)}
                      className="flex items-center gap-2 text-left"
                    >
                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                      <CardTitle className="text-base">
                        {template.name}
                      </CardTitle>
                    </button>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setEditingTemplate(template)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleDeleteTemplate(template.id)}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </div>
                  {template.description && (
                    <p className="text-sm text-muted-foreground ml-6">
                      {template.description}
                    </p>
                  )}
                </CardHeader>
                {isExpanded && (
                  <CardContent>
                    <div className="space-y-2">
                      {template.variants.map((variant, idx) => (
                        <div
                          key={variant.name}
                          className={`p-3 rounded-md border ${
                            idx === (template.defaultVariantIndex ?? 0)
                              ? "border-primary bg-primary/5"
                              : "border-border"
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-medium">{variant.name}</span>
                            {idx === (template.defaultVariantIndex ?? 0) && (
                              <span className="text-xs text-primary">
                                Default
                              </span>
                            )}
                          </div>
                          <div className="text-sm text-muted-foreground mt-1 space-y-0.5">
                            <p>
                              Model: {variant.model.providerID}/
                              {variant.model.modelID}
                            </p>
                            {variant.variant && (
                              <p>Variant: {variant.variant}</p>
                            )}
                            {variant.agent && <p>Agent: {variant.agent}</p>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                )}
              </Card>
            );
          })}
        </div>
      )}

      <TaskTemplateEditDialog
        template={editingTemplate}
        onClose={() => setEditingTemplate(null)}
        onSave={handleSaveTemplate}
        isNew={
          editingTemplate
            ? !templates.some((t) => t.id === editingTemplate.id)
            : false
        }
        isSaving={updateMutation.isPending}
        existingTemplates={templates}
        onSaveNew={(newTemplate) => {
          updateMutation.mutate([...templates, newTemplate], {
            onSuccess: () => setEditingTemplate(null),
          });
        }}
      />
    </div>
  );
}

function TaskTemplateEditDialog({
  template,
  onClose,
  onSave,
  isNew,
  isSaving,
  onSaveNew,
}: {
  template: TaskTemplate | null;
  onClose: () => void;
  onSave: (template: TaskTemplate) => void;
  isNew: boolean;
  isSaving: boolean;
  existingTemplates: TaskTemplate[];
  onSaveNew: (template: TaskTemplate) => void;
}) {
  const [editData, setEditData] = useState<TaskTemplate | null>(null);

  const data = editData ?? template;

  if (!template) return null;

  const handleOpen = () => {
    setEditData({ ...template });
  };

  const handleSave = () => {
    if (!data) return;
    if (isNew) {
      onSaveNew(data);
    } else {
      onSave(data);
    }
  };

  const updateVariant = (
    idx: number,
    field: keyof TaskTemplate["variants"][number],
    value: string | { providerID: string; modelID: string },
  ) => {
    if (!data) return;
    const newVariants = data.variants.map((v, i) =>
      i === idx ? { ...v, [field]: value } : v,
    );
    setEditData({ ...data, variants: newVariants });
  };

  const addVariant = () => {
    if (!data) return;
    setEditData({
      ...data,
      variants: [
        ...data.variants,
        {
          name: `Variant ${data.variants.length + 1}`,
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
          variant: "high",
          agent: "Sisyphus",
        },
      ],
    });
  };

  const removeVariant = (idx: number) => {
    if (!data || data.variants.length <= 1) return;
    const newVariants = data.variants.filter((_, i) => i !== idx);
    const newDefault =
      data.defaultVariantIndex === idx
        ? 0
        : (data.defaultVariantIndex ?? 0) > idx
          ? (data.defaultVariantIndex ?? 0) - 1
          : data.defaultVariantIndex;
    setEditData({
      ...data,
      variants: newVariants,
      defaultVariantIndex: newDefault,
    });
  };

  return (
    <Dialog
      open={!!template}
      onOpenChange={(open) => {
        if (!open) onClose();
        else handleOpen();
      }}
    >
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isNew ? "Create Template" : "Edit Template"}
          </DialogTitle>
          <DialogDescription>
            Configure the template name and variants
          </DialogDescription>
        </DialogHeader>

        {data && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Template ID</Label>
                <Input
                  value={data.id}
                  onChange={(e) => setEditData({ ...data, id: e.target.value })}
                  disabled={!isNew}
                  className="font-mono"
                />
              </div>
              <div className="space-y-2">
                <Label>Name</Label>
                <Input
                  value={data.name}
                  onChange={(e) =>
                    setEditData({ ...data, name: e.target.value })
                  }
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Description</Label>
              <Input
                value={data.description ?? ""}
                onChange={(e) =>
                  setEditData({ ...data, description: e.target.value })
                }
                placeholder="Optional description"
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Variants</Label>
                <Button variant="outline" size="sm" onClick={addVariant}>
                  <Plus className="h-3 w-3 mr-1" />
                  Add Variant
                </Button>
              </div>

              <div className="space-y-3">
                {data.variants.map((variant, idx) => (
                  <div key={idx} className="p-3 border rounded-md space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Input
                          value={variant.name}
                          onChange={(e) =>
                            updateVariant(idx, "name", e.target.value)
                          }
                          className="w-40"
                          placeholder="Variant name"
                        />
                        <label className="flex items-center gap-1.5 text-sm">
                          <input
                            type="radio"
                            name="defaultVariant"
                            checked={idx === (data.defaultVariantIndex ?? 0)}
                            onChange={() =>
                              setEditData({
                                ...data,
                                defaultVariantIndex: idx,
                              })
                            }
                            className="h-4 w-4"
                          />
                          Default
                        </label>
                      </div>
                      {data.variants.length > 1 && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => removeVariant(idx)}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      )}
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label className="text-xs">Provider ID</Label>
                        <Input
                          value={variant.model.providerID}
                          onChange={(e) =>
                            updateVariant(idx, "model", {
                              ...variant.model,
                              providerID: e.target.value,
                            })
                          }
                          placeholder="anthropic"
                          className="font-mono text-sm"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">Model ID</Label>
                        <Input
                          value={variant.model.modelID}
                          onChange={(e) =>
                            updateVariant(idx, "model", {
                              ...variant.model,
                              modelID: e.target.value,
                            })
                          }
                          placeholder="claude-sonnet-4-5"
                          className="font-mono text-sm"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">Variant</Label>
                        <Select
                          value={variant.variant ?? ""}
                          onValueChange={(v) =>
                            updateVariant(idx, "variant", v)
                          }
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select variant" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="standard">Standard</SelectItem>
                            <SelectItem value="high">High</SelectItem>
                            <SelectItem value="max">Max</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">Agent</Label>
                        <Input
                          value={variant.agent ?? ""}
                          onChange={(e) =>
                            updateVariant(idx, "agent", e.target.value)
                          }
                          placeholder="Sisyphus"
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : isNew ? (
              "Create"
            ) : (
              "Save"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
