import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { useState } from "react";
import type { ConfigFile } from "@/api/client";
import {
  configFilesListQuery,
  sandboxListQuery,
  useCreateConfigFile,
  useDeleteConfigFile,
  useRestartSandbox,
  useSyncConfigsToSandboxes,
  useUpdateConfigFile,
  workspaceListQuery,
} from "@/api/queries";
import { McpConnectionSection } from "@/components/mcp-connection-section";
import {
  AddConfigFileDialog,
  ConfigFileCard,
  RestartSandboxesDialog,
  SessionTemplatesSection,
  SharedAuthSection,
  SystemModelConfigSection,
} from "@/components/settings";
import { SshKeysSection } from "@/components/ssh-keys-section";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

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

  const { data: workspaceConfigCounts } = useQuery({
    ...configFilesListQuery({ scope: "workspace" }),
    select: (configs) => {
      const counts = new Map<string, number>();
      for (const c of configs ?? []) {
        if (c.workspaceId) {
          counts.set(c.workspaceId, (counts.get(c.workspaceId) ?? 0) + 1);
        }
      }
      return counts;
    },
  });

  const { data: sandboxes } = useQuery(sandboxListQuery({ status: "running" }));

  const createMutation = useCreateConfigFile();
  const updateMutation = useUpdateConfigFile();
  const deleteMutation = useDeleteConfigFile();
  const syncMutation = useSyncConfigsToSandboxes();
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

  const configCounts = workspaceConfigCounts ?? new Map<string, number>();

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
      <McpConnectionSection />
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
            Sync to Sandboxes
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
              const count = configCounts.get(workspace.id) ?? 0;
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

      <SystemModelConfigSection />

      <SharedAuthSection />

      <SessionTemplatesSection />
    </div>
  );
}
