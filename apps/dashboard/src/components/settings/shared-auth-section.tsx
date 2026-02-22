import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { sharedAuthListQuery, useUpdateSharedAuth } from "@/api/queries";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";

export function SharedAuthSection() {
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
