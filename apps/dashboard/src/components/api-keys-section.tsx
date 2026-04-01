import { useQuery } from "@tanstack/react-query";
import { Check, Copy, Key, Loader2, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { ApiKey } from "@/api/client";
import {
  apiKeysListQuery,
  useCreateApiKey,
  useDeleteApiKey,
} from "@/api/queries";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";

export function ApiKeysSection() {
  const { data: keys, isLoading } = useQuery(apiKeysListQuery);
  const deleteMutation = useDeleteApiKey();
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  if (isLoading) {
    return <div className="animate-pulse h-32 bg-muted rounded" />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold">API Keys</h2>
          <p className="text-sm text-muted-foreground">
            Manage API keys for the OpenCode plugin or external integrations
          </p>
        </div>
        <Button onClick={() => setAddDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          Create API Key
        </Button>
      </div>

      <div className="space-y-3">
        {(!keys || keys.length === 0) && (
          <Card>
            <CardContent className="py-8 text-center text-muted-foreground">
              No API keys yet. Create one to use with the OpenCode plugin.
            </CardContent>
          </Card>
        )}
        {keys?.map((key: ApiKey) => (
          <Card key={key.id}>
            <CardHeader className="flex flex-row items-center justify-between py-3">
              <div className="flex items-center gap-3">
                <Key className="h-4 w-4 text-muted-foreground" />
                <div>
                  <CardTitle className="text-sm font-medium">
                    {key.name}
                  </CardTitle>
                  <p className="text-xs text-muted-foreground font-mono">
                    {key.keyPrefix}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  Created {new Date(key.createdAt).toLocaleDateString()}
                </span>
                {key.lastUsedAt && (
                  <span className="text-xs text-muted-foreground">
                    • Last used {new Date(key.lastUsedAt).toLocaleDateString()}
                  </span>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    if (window.confirm(`Delete API key "${key.name}"?`)) {
                      setDeletingId(key.id);
                      deleteMutation.mutate(key.id, {
                        onSettled: () => setDeletingId(null),
                        onError: () => {
                          toast.error("Failed to delete API key");
                          setDeletingId(null);
                        },
                      });
                    }
                  }}
                  disabled={deletingId === key.id}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            </CardHeader>
          </Card>
        ))}
      </div>

      <AddApiKeyDialog open={addDialogOpen} onOpenChange={setAddDialogOpen} />
    </div>
  );
}

function AddApiKeyDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createMutation = useCreateApiKey();
  const { copy, isCopied } = useCopyToClipboard();
  const [name, setName] = useState("");
  const [createdKey, setCreatedKey] = useState<{
    apiKey: ApiKey;
    rawKey: string;
  } | null>(null);

  const handleSubmit = async () => {
    if (!name.trim()) return;

    try {
      await createMutation.mutateAsync(
        { name: name.trim() },
        {
          onSuccess: (data) => {
            setCreatedKey(data);
          },
        },
      );
    } catch {
      toast.error("Failed to create API key");
    }
  };

  const handleClose = (isOpen: boolean) => {
    if (!isOpen) {
      setName("");
      setCreatedKey(null);
    }
    onOpenChange(isOpen);
  };

  const atelierConfig = createdKey
    ? JSON.stringify(
        {
          managerUrl: window.location.origin,
          apiKey: createdKey.rawKey,
        },
        null,
        2,
      )
    : null;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create API Key</DialogTitle>
        </DialogHeader>

        {!createdKey ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSubmit();
            }}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label>Key Name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My API Key"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => handleClose(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!name.trim() || createMutation.isPending}
              >
                {createMutation.isPending && (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                )}
                Create Key
              </Button>
            </div>
          </form>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>API Key</Label>
              <div className="flex gap-2">
                <code className="flex-1 bg-muted px-3 py-2 rounded text-sm font-mono flex items-center overflow-x-auto">
                  {createdKey.rawKey}
                </code>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => copy(createdKey.rawKey, "token")}
                >
                  {isCopied("token") ? (
                    <Check className="h-4 w-4 text-green-500" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              </div>
              <p className="text-xs text-amber-600">
                Save this key now — it won't be shown again.
              </p>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Atelier Config</Label>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={() => copy(atelierConfig ?? "", "config")}
                >
                  {isCopied("config") ? (
                    <span className="text-green-500 flex items-center gap-1">
                      <Check className="h-3 w-3" /> Copied
                    </span>
                  ) : (
                    <span className="flex items-center gap-1">
                      <Copy className="h-3 w-3" /> Copy Config
                    </span>
                  )}
                </Button>
              </div>
              <pre className="bg-muted p-3 rounded text-xs font-mono overflow-x-auto">
                {atelierConfig}
              </pre>
              <p className="text-xs text-muted-foreground">
                Save as ~/.config/opencode/atelier.json or
                .opencode/atelier.json
              </p>
            </div>
            <div className="flex justify-end">
              <Button onClick={() => handleClose(false)}>Done</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
