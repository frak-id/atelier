import { type FileEntry, isSecretRef } from "@atelier/spec";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";

/**
 * Files a toolbox writes into every sandbox it applies to: a path, its
 * content (literal text or the name of an org secret), an octal mode and an
 * owner. Secret content is resolved by the server at spawn, from the spawn
 * org's secrets.
 */
export function ToolboxFilesField({
  value,
  onChange,
}: {
  value: FileEntry[];
  onChange: (files: FileEntry[]) => void;
}) {
  function update(index: number, patch: Partial<FileEntry>) {
    onChange(
      value.map((file, i) => (i === index ? { ...file, ...patch } : file)),
    );
  }

  return (
    <div className="space-y-2">
      {value.map((file, index) => {
        const secret = isSecretRef(file.content);
        return (
          // Files have no stable id; the list is edited in place.
          // biome-ignore lint/suspicious/noArrayIndexKey: positional rows
          <div key={index} className="space-y-2 rounded-md border p-2">
            <div className="flex gap-2">
              <Input
                value={file.path}
                onChange={(e) => update(index, { path: e.target.value })}
                placeholder="/home/dev/.config/tool/key"
                aria-label="File path"
                className="font-mono"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="Remove file"
                onClick={() => onChange(value.filter((_, i) => i !== index))}
              >
                <Trash2 />
              </Button>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[8rem_1fr]">
              <NativeSelect
                value={secret ? "secret" : "text"}
                aria-label="Content type"
                onChange={(e) =>
                  update(index, {
                    content: e.target.value === "secret" ? { $secret: "" } : "",
                  })
                }
              >
                <option value="text">Text</option>
                <option value="secret">Secret</option>
              </NativeSelect>
              {isSecretRef(file.content) ? (
                <Input
                  value={file.content.$secret}
                  onChange={(e) =>
                    update(index, { content: { $secret: e.target.value } })
                  }
                  placeholder="SECRET_NAME"
                  aria-label="Secret name"
                  className="font-mono"
                />
              ) : (
                <Textarea
                  value={file.content}
                  onChange={(e) => update(index, { content: e.target.value })}
                  spellCheck={false}
                  aria-label="File content"
                  className="min-h-16 p-2"
                />
              )}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Input
                value={file.mode ?? ""}
                onChange={(e) =>
                  update(index, { mode: e.target.value || undefined })
                }
                placeholder="mode, e.g. 600"
                aria-label="File mode"
                className="font-mono"
              />
              <Input
                value={file.owner ?? ""}
                onChange={(e) =>
                  update(index, { owner: e.target.value || undefined })
                }
                placeholder="owner, e.g. dev"
                aria-label="File owner"
                className="font-mono"
              />
            </div>
          </div>
        );
      })}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onChange([...value, { path: "", content: "" }])}
      >
        <Plus />
        Add file
      </Button>
    </div>
  );
}
