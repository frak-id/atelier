import { Download, Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import type { ConfigFile } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";

export function ConfigFileCard({
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
