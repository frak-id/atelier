import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  ExternalLink,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Terminal,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import {
  sandboxDetailQuery,
  sandboxMetricsQuery,
  sandboxServicesQuery,
  useDeleteSandbox,
  useExecCommand,
  useStartSandbox,
  useStopSandbox,
} from "@/api/queries";
import { SandboxTerminal } from "@/components/terminal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatBytes, formatDate } from "@/lib/utils";

export const Route = createFileRoute("/sandboxes/$id")({
  component: SandboxDetailPage,
  loader: ({ context, params }) => {
    context.queryClient.ensureQueryData(sandboxDetailQuery(params.id));
  },
  pendingComponent: () => (
    <div className="p-6 space-y-6">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-64" />
    </div>
  ),
});

function SandboxDetailPage() {
  const { id } = Route.useParams();
  const navigate = Route.useNavigate();
  const { data: sandbox } = useSuspenseQuery(sandboxDetailQuery(id));

  const { data: metrics } = useQuery({
    ...sandboxMetricsQuery(id),
    enabled: sandbox.status === "running",
  });
  const { data: services } = useQuery({
    ...sandboxServicesQuery(id),
    enabled: sandbox.status === "running",
  });

  const deleteMutation = useDeleteSandbox();
  const stopMutation = useStopSandbox();
  const startMutation = useStartSandbox();
  const [command, setCommand] = useState("");
  const [execOutput, setExecOutput] = useState<{
    stdout: string;
    stderr: string;
    exitCode: number;
  } | null>(null);
  const execMutation = useExecCommand(id);

  const handleDelete = () => {
    if (confirm(`Delete sandbox ${id}?`)) {
      deleteMutation.mutate(id, {
        onSuccess: () => navigate({ to: "/sandboxes" }),
      });
    }
  };

  const handleExec = () => {
    if (!command.trim()) return;
    execMutation.mutate(
      { command },
      {
        onSuccess: (result) => {
          setExecOutput(result);
          setCommand("");
        },
      },
    );
  };

  const statusVariant = {
    running: "success",
    creating: "warning",
    stopped: "secondary",
    error: "error",
  } as const;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/sandboxes">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold">{sandbox.id}</h1>
            <Badge variant={statusVariant[sandbox.status]}>
              {sandbox.status}
            </Badge>
          </div>
          <p className="text-muted-foreground">
            Created {formatDate(sandbox.createdAt)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {sandbox.status === "running" && (
            <>
              <Button variant="outline" asChild>
                <a
                  href={sandbox.urls.vscode}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink className="h-4 w-4 mr-2" />
                  VSCode
                </a>
              </Button>
              <Button variant="outline" asChild>
                <a
                  href={sandbox.urls.opencode}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink className="h-4 w-4 mr-2" />
                  OpenCode
                </a>
              </Button>
              <Button
                variant="outline"
                onClick={() => stopMutation.mutate(id)}
                disabled={stopMutation.isPending}
              >
                {stopMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Pause className="h-4 w-4 mr-2" />
                )}
                Stop
              </Button>
            </>
          )}
          {sandbox.status === "stopped" && (
            <Button
              variant="outline"
              onClick={() => startMutation.mutate(id)}
              disabled={startMutation.isPending}
            >
              {startMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Play className="h-4 w-4 mr-2" />
              )}
              Start
            </Button>
          )}
          <Button variant="destructive" onClick={handleDelete}>
            <Trash2 className="h-4 w-4 mr-2" />
            Delete
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <DetailRow label="ID" value={sandbox.id} mono />
            <DetailRow label="IP Address" value={sandbox.ipAddress} mono />
            <DetailRow label="MAC Address" value={sandbox.macAddress} mono />
            <DetailRow
              label="Resources"
              value={`${sandbox.resources.vcpus} vCPU / ${sandbox.resources.memoryMb}MB`}
            />
            {sandbox.projectId && (
              <DetailRow label="Project" value={sandbox.projectId} />
            )}
            {sandbox.branch && (
              <DetailRow label="Branch" value={sandbox.branch} mono />
            )}
            {sandbox.pid && (
              <DetailRow label="PID" value={String(sandbox.pid)} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>URLs</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <UrlRow label="VSCode" url={sandbox.urls.vscode} />
            <UrlRow label="OpenCode" url={sandbox.urls.opencode} />
            {sandbox.urls.terminal && (
              <UrlRow label="Terminal" url={sandbox.urls.terminal} />
            )}
            <DetailRow label="SSH" value={sandbox.urls.ssh} mono />
          </CardContent>
        </Card>

        {sandbox.status === "running" && metrics && (
          <Card>
            <CardHeader>
              <CardTitle>Resources</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <div className="flex justify-between text-sm mb-1">
                  <span>CPU</span>
                  <span>{metrics.cpu.toFixed(1)}%</span>
                </div>
                <div className="h-2 bg-secondary rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{ width: `${Math.min(metrics.cpu, 100)}%` }}
                  />
                </div>
              </div>
              <div>
                <div className="flex justify-between text-sm mb-1">
                  <span>Memory</span>
                  <span>
                    {formatBytes(metrics.memory.used)} /{" "}
                    {formatBytes(metrics.memory.total)}
                  </span>
                </div>
                <div className="h-2 bg-secondary rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{ width: `${metrics.memory.percent}%` }}
                  />
                </div>
              </div>
              <div>
                <div className="flex justify-between text-sm mb-1">
                  <span>Disk</span>
                  <span>
                    {formatBytes(metrics.disk.used)} /{" "}
                    {formatBytes(metrics.disk.total)}
                  </span>
                </div>
                <div className="h-2 bg-secondary rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{ width: `${metrics.disk.percent}%` }}
                  />
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {sandbox.status === "running" && (
        <Tabs defaultValue="services">
          <TabsList>
            <TabsTrigger value="services">Services</TabsTrigger>
            <TabsTrigger value="terminal">Terminal</TabsTrigger>
            <TabsTrigger value="exec">Exec</TabsTrigger>
          </TabsList>

          <TabsContent value="services">
            <Card>
              <CardHeader>
                <CardTitle>Services</CardTitle>
              </CardHeader>
              <CardContent>
                {services?.services ? (
                  <div className="space-y-2">
                    {services.services.map((service) => (
                      <div
                        key={service.name}
                        className="flex items-center justify-between py-2 border-b last:border-0"
                      >
                        <span>{service.name}</span>
                        <div className="flex items-center gap-2">
                          {service.pid && (
                            <span className="text-sm text-muted-foreground">
                              PID: {service.pid}
                            </span>
                          )}
                          <Badge
                            variant={service.running ? "success" : "error"}
                          >
                            {service.running ? "Running" : "Stopped"}
                          </Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-muted-foreground">Loading services...</p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="terminal" className="h-[500px]">
            {sandbox.urls.terminal && (
              <SandboxTerminal terminalUrl={sandbox.urls.terminal} />
            )}
          </TabsContent>

          <TabsContent value="exec">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Terminal className="h-5 w-5" />
                  Execute Command
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex gap-2">
                  <Input
                    placeholder="Enter command..."
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleExec()}
                    className="font-mono"
                  />
                  <Button
                    onClick={handleExec}
                    disabled={execMutation.isPending || !command.trim()}
                  >
                    {execMutation.isPending ? (
                      <RefreshCw className="h-4 w-4 animate-spin" />
                    ) : (
                      <Play className="h-4 w-4" />
                    )}
                  </Button>
                </div>
                {execOutput && (
                  <div className="bg-black rounded-lg p-4 font-mono text-sm text-green-400">
                    <div className="flex items-center justify-between mb-2 text-xs text-muted-foreground">
                      <span>Exit code: {execOutput.exitCode}</span>
                    </div>
                    {execOutput.stdout && (
                      <pre className="whitespace-pre-wrap">
                        {execOutput.stdout}
                      </pre>
                    )}
                    {execOutput.stderr && (
                      <pre className="whitespace-pre-wrap text-red-400">
                        {execOutput.stderr}
                      </pre>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      )}

      {sandbox.error && (
        <Card className="border-destructive">
          <CardHeader>
            <CardTitle className="text-destructive">Error</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="whitespace-pre-wrap text-sm">{sandbox.error}</pre>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function DetailRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={mono ? "font-mono" : ""}>{value}</span>
    </div>
  );
}

function UrlRow({ label, url }: { label: string; url: string }) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-muted-foreground">{label}</span>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary hover:underline flex items-center gap-1"
      >
        Open <ExternalLink className="h-3 w-3" />
      </a>
    </div>
  );
}
