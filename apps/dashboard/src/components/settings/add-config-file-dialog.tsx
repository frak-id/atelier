import { Plus, Upload } from "lucide-react";
import { useRef, useState } from "react";
import type { ConfigFileContentType } from "@/api/client";
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

export function AddConfigFileDialog({
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
