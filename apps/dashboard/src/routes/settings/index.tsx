import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Download, ExternalLink, Plus, Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { api, type ConfigFile, type ConfigFileContentType } from "@/api/client";
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

export const Route = createFileRoute("/settings/")({
  component: SettingsPage,
});

function SettingsPage() {
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);

  const { data: globalConfigs, isLoading: loadingGlobal } = useQuery({
    queryKey: ["config-files", "global"],
    queryFn: () => api.configFiles.list({ scope: "global" }),
  });

  const { data: projects } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.projects.list(),
  });

  const { data: allProjectConfigs } = useQuery({
    queryKey: ["config-files", "project"],
    queryFn: () => api.configFiles.list({ scope: "project" }),
  });

  const createMutation = useMutation({
    mutationFn: api.configFiles.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["config-files"] });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: { content?: string } }) =>
      api.configFiles.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["config-files"] });
      setEditingId(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: api.configFiles.delete,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["config-files"] });
    },
  });

  const projectConfigCounts = new Map<string, number>();
  allProjectConfigs?.forEach((c) => {
    if (c.projectId) {
      projectConfigCounts.set(
        c.projectId,
        (projectConfigCounts.get(c.projectId) ?? 0) + 1,
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
      <div>
        <h1 className="text-2xl font-bold">Global Config Files</h1>
        <p className="text-muted-foreground">
          Configuration files injected into all sandboxes
        </p>
      </div>

      <AddConfigFileDialog
        onAdd={(data) => createMutation.mutate({ ...data, scope: "global" })}
        isPending={createMutation.isPending}
      />

      <div className="space-y-4">
        {globalConfigs?.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-muted-foreground">
              No global config files. Click "Add Config File" to create one.
            </CardContent>
          </Card>
        ) : (
          globalConfigs?.map((config) => (
            <ConfigFileCard
              key={config.id}
              config={config}
              isEditing={editingId === config.id}
              onEdit={() => setEditingId(config.id)}
              onSave={(content) =>
                updateMutation.mutate({ id: config.id, data: { content } })
              }
              onCancel={() => setEditingId(null)}
              onDelete={() => {
                if (confirm(`Delete config file ${config.path}?`)) {
                  deleteMutation.mutate(config.id);
                }
              }}
              isSaving={updateMutation.isPending}
            />
          ))
        )}
      </div>

      <div className="border-t pt-6">
        <h2 className="text-xl font-bold mb-4">Project Config Overrides</h2>
        {projects?.length === 0 ? (
          <p className="text-muted-foreground">No projects yet.</p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {projects?.map((project) => {
              const count = projectConfigCounts.get(project.id) ?? 0;
              return (
                <Card key={project.id}>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex items-center justify-between">
                      {project.name}
                      <Link to="/projects/$id" params={{ id: project.id }}>
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
            placeholder="~/.config/opencode/auth.json"
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
