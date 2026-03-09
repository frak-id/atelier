import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
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
import { ApiTokenSection } from "@/components/api-token-section";
import { McpConnectionSection } from "@/components/mcp-connection-section";
import {
  AddConfigFileDialog,
  CLIProxySection,
  ConfigFileCard,
  RestartSandboxesDialog,
  SessionTemplatesSection,
  SharedAuthSection,
  SystemModelConfigSection,
} from "@/components/settings";
import { SshKeysSection } from "@/components/ssh-keys-section";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const SETTINGS_TABS = ["connection", "files", "agent"] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number];
export const Route = createFileRoute("/settings/")({
  component: SettingsPage,
  validateSearch: (search: Record<string, unknown>): { tab: SettingsTab } => {
    const tab = search.tab as string;
    if (SETTINGS_TABS.includes(tab as SettingsTab)) {
      return { tab: tab as SettingsTab };
    }
    return { tab: "connection" };
  },
});
function SettingsPage() {
  const { tab } = Route.useSearch();
  const navigate = useNavigate();

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

  return (
    <div className="p-6">
      <Tabs
        value={tab}
        onValueChange={(value) =>
          navigate({
            to: "/settings",
            search: { tab: value as SettingsTab },
            replace: true,
          })
        }
      >
        <TabsList>
          <TabsTrigger value="connection">Connection</TabsTrigger>
          <TabsTrigger value="files">Files & Auth</TabsTrigger>
          <TabsTrigger value="agent">Agent & Models</TabsTrigger>
        </TabsList>

        {/* Connection — MCP server details + SSH keys */}
        <TabsContent value="connection" className="mt-6 space-y-6">
          <McpConnectionSection />
          <ApiTokenSection />
          <SshKeysSection />
        </TabsContent>

        {/* Files & Auth — config files, shared auth, workspace overrides */}
        <TabsContent value="files" className="mt-6 space-y-6">
          <div>
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-bold">Global Config Files</h2>
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

          {loadingGlobal ? (
            <div className="animate-pulse space-y-4">
              <div className="h-32 bg-muted rounded" />
              <div className="h-32 bg-muted rounded" />
            </div>
          ) : (
            <div className="space-y-4">
              {globalConfigs?.length === 0 ? (
                <Card>
                  <CardContent className="py-8 text-center text-muted-foreground">
                    No global config files. Click &quot;Add Config File&quot; to
                    create one.
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
                        {
                          id: config.id,
                          data: { content },
                        },
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
          )}

          <SharedAuthSection />

          <div className="border-t pt-6">
            <h2 className="text-xl font-bold mb-4">
              Workspace Config Overrides
            </h2>
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
                          <Link
                            to="/workspaces/$id"
                            params={{
                              id: workspace.id,
                            }}
                          >
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
        </TabsContent>

        {/* Agent & Models — session templates + system model config */}
        <TabsContent value="agent" className="mt-6 space-y-6">
          <CLIProxySection />
          <SessionTemplatesSection />
          <SystemModelConfigSection />
        </TabsContent>
      </Tabs>
      <RestartSandboxesDialog
        open={showRestartDialog}
        onOpenChange={setShowRestartDialog}
        sandboxes={runningSandboxes}
        selectedIds={selectedSandboxes}
        onSelectedChange={setSelectedSandboxes}
        onConfirm={handleRestartSelected}
        isRestarting={restartMutation.isPending}
      />
    </div>
  );
}
