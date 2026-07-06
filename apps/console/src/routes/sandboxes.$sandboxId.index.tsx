import type { ProcessStatus, SandboxUrl } from "@atelier/spec";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Loader2,
  Maximize2,
  MessagesSquare,
  Minimize2,
  Play,
  Radio,
  Square,
  Star,
} from "lucide-react";
import { type FormEvent, useState } from "react";
import {
  processLogsQuery,
  sandboxDetailQuery,
  useAddPort,
  useDestroySandbox,
  usePauseSandbox,
  useProcessAction,
  useResumeSandbox,
  useSnapshotSandbox,
} from "@/api/queries/sandboxes";
import { useCaptureToolset } from "@/api/queries/toolsets";
import { ImmersiveView } from "@/components/immersive-view";
import { MultiTerminal } from "@/components/multi-terminal";
import { TerminalView } from "@/components/terminal-view";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot } from "@/components/ui/status-dot";
import {
  harnessFromAnnotations,
  sandboxStatusPresentation,
} from "@/lib/sandbox-status";
import { useLens } from "@/providers/lens";

export const Route = createFileRoute("/sandboxes/$sandboxId/")({
  component: SandboxDetailPage,
});

function SandboxDetailPage() {
  const { sandboxId } = Route.useParams();
  const navigate = useNavigate();
  const {
    data: sandbox,
    isPending,
    isError,
    error,
  } = useQuery(sandboxDetailQuery(sandboxId));
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [immersive, setImmersive] = useState(false);
  const pause = usePauseSandbox();
  const resume = useResumeSandbox();
  const destroy = useDestroySandbox();
  const snapshot = useSnapshotSandbox();
  const { lens } = useLens();

  if (isPending) {
    return (
      <div className="mx-auto max-w-5xl space-y-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (isError || !sandbox) {
    return (
      <div className="mx-auto max-w-5xl">
        <Card className="border-destructive/50">
          <CardHeader>
            <CardTitle>Sandbox not found</CardTitle>
            <CardDescription>
              {error instanceof Error ? error.message : "Unknown error"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link to="/" className="text-sm underline">
              Back to fleet
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  const status = sandboxStatusPresentation(sandbox.status);
  const harness = harnessFromAnnotations(sandbox.annotations);

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <Link to="/" className="text-sm text-muted-foreground underline">
            Fleet
          </Link>
          <span className="text-muted-foreground">/</span>
          <span className="truncate font-mono text-sm">{sandbox.id}</span>
          <Badge variant={status.variant}>{status.label}</Badge>
          {harness ? <Badge variant="outline">{harness}</Badge> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setImmersive(true)}
          >
            <Maximize2 />
            Immerse
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link
              to="/sandboxes/$sandboxId/sessions"
              params={{ sandboxId: sandbox.id }}
            >
              <MessagesSquare />
              Sessions
            </Link>
          </Button>
          {sandbox.status === "running" ? (
            <Button
              variant="outline"
              size="sm"
              disabled={pause.isPending}
              onClick={() => pause.mutate(sandbox.id)}
            >
              {pause.isPending ? <Loader2 className="animate-spin" /> : null}
              Pause
            </Button>
          ) : null}
          {sandbox.status === "paused" ? (
            <Button
              variant="outline"
              size="sm"
              disabled={resume.isPending}
              onClick={() => resume.mutate(sandbox.id)}
            >
              {resume.isPending ? <Loader2 className="animate-spin" /> : null}
              Resume
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            disabled={snapshot.isPending}
            onClick={() => snapshot.mutate(sandbox.id)}
          >
            {snapshot.isPending ? <Loader2 className="animate-spin" /> : null}
            Snapshot
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={destroy.isPending}
            onClick={() => setConfirmOpen(true)}
          >
            {destroy.isPending ? <Loader2 className="animate-spin" /> : null}
            Destroy
          </Button>
        </div>
      </div>

      <UrlsSection urls={sandbox.urls} />
      <TerminalSection sandboxId={sandbox.id} />
      {lens === "builder" ? (
        <>
          <ProcessesSection
            sandboxId={sandbox.id}
            processes={sandbox.processes}
          />
          <ExposePortSection sandboxId={sandbox.id} />
          <CaptureToolsetSection sandboxId={sandbox.id} />
          {sandbox.annotations || sandbox.metadata ? (
            <MetadataSection
              annotations={sandbox.annotations}
              metadata={sandbox.metadata}
            />
          ) : null}
        </>
      ) : null}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Destroy sandbox?</DialogTitle>
            <DialogDescription>
              This permanently deletes{" "}
              <span className="font-mono">{sandbox.id}</span>. This cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={destroy.isPending}
              onClick={() => {
                destroy.mutate(sandbox.id, {
                  onSuccess: () => navigate({ to: "/" }),
                });
                setConfirmOpen(false);
              }}
            >
              Destroy
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {immersive ? (
        <ImmersiveView sandbox={sandbox} onClose={() => setImmersive(false)} />
      ) : null}
    </div>
  );
}

/** Expandable terminal panel embedded in the sandbox's main view. Toggles
 * between an inline height and a tall pane; the immersive view offers a
 * full-screen terminal on top of this. */
function TerminalSection({ sandboxId }: { sandboxId: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle>Terminal</CardTitle>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? <Minimize2 /> : <Maximize2 />}
          {expanded ? "Collapse" : "Expand"}
        </Button>
      </CardHeader>
      <CardContent>
        <MultiTerminal
          sandboxId={sandboxId}
          className={expanded ? "h-[70vh]" : undefined}
        />
      </CardContent>
    </Card>
  );
}

function UrlsSection({ urls }: { urls: SandboxUrl[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>URLs</CardTitle>
      </CardHeader>
      <CardContent>
        {urls.length === 0 ? (
          <p className="text-sm text-muted-foreground">No exposed URLs.</p>
        ) : (
          <ul className="space-y-1">
            {urls.map((u) => (
              <li key={u.name} className="flex items-center gap-2 text-sm">
                <span className="font-medium">{u.name}</span>
                <a
                  href={u.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 truncate text-muted-foreground underline"
                >
                  {u.url}
                  <ExternalLink className="size-3 shrink-0" />
                </a>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function ProcessesSection({
  sandboxId,
  processes,
}: {
  sandboxId: string;
  processes: ProcessStatus[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Processes</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {processes.length === 0 ? (
          <p className="text-sm text-muted-foreground">No processes.</p>
        ) : (
          processes.map((process) => (
            <ProcessRow
              key={process.name}
              sandboxId={sandboxId}
              process={process}
            />
          ))
        )}
      </CardContent>
    </Card>
  );
}

function ProcessRow({
  sandboxId,
  process,
}: {
  sandboxId: string;
  process: ProcessStatus;
}) {
  const [logsOpen, setLogsOpen] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const processAction = useProcessAction(sandboxId);

  return (
    <div className="rounded-md border">
      <div className="flex flex-wrap items-center gap-2 p-3">
        <StatusDot variant={process.running ? "success" : "danger"} />
        <span className="sr-only">
          {process.running ? "running" : "stopped"}
        </span>
        <span className="font-mono text-sm">{process.name}</span>
        {process.primary ? (
          <Badge variant="outline" className="flex items-center gap-1">
            <Star className="size-3" />
            primary
          </Badge>
        ) : null}
        {process.ready !== undefined ? (
          <Badge variant={process.ready ? "success" : "warning"}>
            {process.ready ? "ready" : "not ready"}
          </Badge>
        ) : null}
        {process.exitCode !== undefined ? (
          <span className="text-xs text-muted-foreground">
            exit {process.exitCode}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={processAction.isPending}
            onClick={() =>
              processAction.mutate({
                name: process.name,
                action: process.running ? "stop" : "start",
              })
            }
          >
            {processAction.isPending ? (
              <Loader2 className="animate-spin" />
            ) : process.running ? (
              <Square />
            ) : (
              <Play />
            )}
            {process.running ? "Stop" : "Start"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setLogsOpen((open) => !open)}
          >
            {logsOpen ? <ChevronDown /> : <ChevronRight />}
            Logs
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setAttachOpen((open) => !open)}
          >
            <Radio />
            Attach
          </Button>
        </div>
      </div>
      {logsOpen ? (
        <ProcessLogs sandboxId={sandboxId} name={process.name} />
      ) : null}
      {attachOpen ? (
        <div className="border-t">
          <TerminalView
            wsPath={`/v1/sandboxes/${sandboxId}/attach/${process.name}?mode=ro`}
            readOnly
          />
        </div>
      ) : null}
    </div>
  );
}

function ProcessLogs({ sandboxId, name }: { sandboxId: string; name: string }) {
  const { data, isPending, isError, error } = useQuery(
    processLogsQuery(sandboxId, name),
  );

  return (
    <div className="border-t p-3">
      {isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : isError ? (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load logs"}
        </p>
      ) : (
        <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 font-mono text-xs">
          {data?.content || "(no output)"}
        </pre>
      )}
    </div>
  );
}

function ExposePortSection({ sandboxId }: { sandboxId: string }) {
  const addPort = useAddPort(sandboxId);
  const [name, setName] = useState("");
  const [port, setPort] = useState("");
  const [isPublic, setIsPublic] = useState(true);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const portNumber = Number(port);
    if (
      !name ||
      !Number.isInteger(portNumber) ||
      portNumber < 1 ||
      portNumber > 65535
    )
      return;
    addPort.mutate(
      { name, port: portNumber, public: isPublic },
      {
        onSuccess: () => {
          setName("");
          setPort("");
        },
      },
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Expose port</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={handleSubmit}
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
        >
          <div className="flex-1 space-y-1">
            <Label htmlFor="port-name">Name</Label>
            <Input
              id="port-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="web"
              required
            />
          </div>
          <div className="flex-1 space-y-1">
            <Label htmlFor="port-number">Port</Label>
            <Input
              id="port-number"
              type="number"
              min={1}
              max={65535}
              value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder="3000"
              required
            />
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="port-public"
              checked={isPublic}
              onChange={(e) => setIsPublic(e.target.checked)}
            />
            <Label htmlFor="port-public">Public</Label>
          </div>
          <Button type="submit" disabled={addPort.isPending}>
            {addPort.isPending ? <Loader2 className="animate-spin" /> : null}
            Expose
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function CaptureToolsetSection({ sandboxId }: { sandboxId: string }) {
  const captureToolset = useCaptureToolset();
  const [name, setName] = useState("");
  const [pathsText, setPathsText] = useState("");
  const [excludeText, setExcludeText] = useState("");
  const [overridesText, setOverridesText] = useState("");

  const linesOf = (text: string) =>
    text
      .split("\n")
      .map((p) => p.trim())
      .filter(Boolean);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const paths = linesOf(pathsText);
    if (!name || paths.length === 0) return;
    const exclude = linesOf(excludeText);
    const overrides = linesOf(overridesText);
    captureToolset.mutate(
      {
        sandboxId,
        name,
        paths,
        ...(exclude.length > 0 ? { exclude } : {}),
        ...(overrides.length > 0 ? { overrides } : {}),
      },
      {
        onSuccess: () => {
          setName("");
          setPathsText("");
          setExcludeText("");
          setOverridesText("");
        },
      },
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Capture toolset</CardTitle>
        <CardDescription>
          Snapshot this sandbox's declared path-sets into a private toolset
          artifact. Known secret files (auth.json, .env*, keys) are excluded and
          the delta is secret-scanned before publish.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="capture-name">Name</Label>
            <Input
              id="capture-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-pi-stack"
              required
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="capture-paths">Paths (one per line)</Label>
            <textarea
              id="capture-paths"
              value={pathsText}
              onChange={(e) => setPathsText(e.target.value)}
              spellCheck={false}
              required
              placeholder={"~/.config/pi\n~/.local/share/pi\n~/.local/bin/pi"}
              className="min-h-20 w-full rounded-md border bg-muted/30 p-2 font-mono text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="capture-exclude">
              Exclude globs (optional, one per line)
            </Label>
            <textarea
              id="capture-exclude"
              value={excludeText}
              onChange={(e) => setExcludeText(e.target.value)}
              spellCheck={false}
              placeholder={"*.log\ncache"}
              className="min-h-12 w-full rounded-md border bg-muted/30 p-2 font-mono text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="capture-overrides">
              Secret-scan overrides (optional, one path per line)
            </Label>
            <textarea
              id="capture-overrides"
              value={overridesText}
              onChange={(e) => setOverridesText(e.target.value)}
              spellCheck={false}
              placeholder={"~/.config/pi/config.json"}
              className="min-h-12 w-full rounded-md border bg-muted/30 p-2 font-mono text-xs"
            />
          </div>
          <Button type="submit" disabled={captureToolset.isPending}>
            {captureToolset.isPending ? (
              <Loader2 className="animate-spin" />
            ) : null}
            Capture
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function MetadataSection({
  annotations,
  metadata,
}: {
  annotations?: Record<string, string>;
  metadata?: Record<string, string>;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Metadata</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {metadata && Object.keys(metadata).length > 0 ? (
          <DefinitionList title="Metadata" entries={metadata} />
        ) : null}
        {annotations && Object.keys(annotations).length > 0 ? (
          <DefinitionList title="Annotations" entries={annotations} />
        ) : null}
      </CardContent>
    </Card>
  );
}

function DefinitionList({
  title,
  entries,
}: {
  title: string;
  entries: Record<string, string>;
}) {
  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
        {title}
      </h3>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
        {Object.entries(entries).map(([key, value]) => (
          <div key={key} className="flex gap-2 min-w-0">
            <dt className="shrink-0 font-mono text-muted-foreground">{key}</dt>
            <dd className="truncate font-mono">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
