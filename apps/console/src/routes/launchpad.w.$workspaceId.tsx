import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  AlertTriangle,
  AppWindow,
  ArrowLeft,
  BookOpen,
  ExternalLink,
  Loader2,
  Maximize2,
  Minimize2,
  Moon,
  MoreHorizontal,
  Play,
  RotateCw,
  Sunrise,
  Trash2,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import {
  useDeleteWorkspace,
  useStartServiceProcesses,
  useUpdateWorkspace,
  useWorkspaceAction,
  type WorkspaceDetail,
  workspaceQuery,
} from "@/api/queries/launchpad";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { InlineEdit } from "@/components/launchpad/inline-edit";
import { PhaseBadge } from "@/components/launchpad/phase-badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot } from "@/components/ui/status-dot";
import { useServiceGate } from "@/hooks/use-service-gate";
import { LaunchpadIconView, PHASE_PRESENTATION } from "@/lib/launchpad";
import { cn } from "@/lib/utils";

interface WorkspaceSearch {
  /** Just launched: open the name field right away. */
  fresh?: boolean;
}

export const Route = createFileRoute("/launchpad/w/$workspaceId")({
  validateSearch: (search: Record<string, unknown>): WorkspaceSearch => ({
    fresh: search.fresh === true || search.fresh === "true" ? true : undefined,
  }),
  component: WorkspacePage,
});

type Service = WorkspaceDetail["services"][number];

function WorkspacePage() {
  const { workspaceId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const {
    data: workspace,
    isPending,
    isError,
    error,
  } = useQuery(workspaceQuery(workspaceId));
  // Read once: a refresh shouldn't re-open the name field.
  const [fresh] = useState(search.fresh === true);
  useEffect(() => {
    if (search.fresh) {
      navigate({
        to: "/launchpad/w/$workspaceId",
        params: { workspaceId },
        search: {},
        replace: true,
      });
    }
  }, [search.fresh, navigate, workspaceId]);

  if (isPending) {
    return (
      <div className="mx-auto w-full max-w-6xl space-y-4 px-4 py-8">
        <Skeleton className="h-10 w-80" />
        <Skeleton className="h-5 w-96" />
        <Skeleton className="h-[60vh] w-full" />
      </div>
    );
  }

  if (isError || !workspace) {
    const missing = (error as { status?: number } | null)?.status === 404;
    return (
      <div className="mx-auto flex w-full max-w-md flex-col items-center gap-4 px-4 py-24 text-center">
        <AlertTriangle className="size-8 text-muted-foreground" />
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">
            {missing
              ? "This workspace is gone"
              : "Couldn't open this workspace"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {missing
              ? "It was deleted, or it belongs to someone else."
              : error instanceof Error
                ? error.message
                : "Please try again in a moment."}
          </p>
        </div>
        <Button asChild>
          <Link to="/launchpad">Back to the Launchpad</Link>
        </Button>
      </div>
    );
  }

  return <WorkspaceView workspace={workspace} fresh={fresh} />;
}

function WorkspaceView({
  workspace,
  fresh,
}: {
  workspace: WorkspaceDetail;
  fresh: boolean;
}) {
  const update = useUpdateWorkspace();
  const save = (patch: { title?: string; description?: string }) =>
    update.mutate({ id: workspace.id, patch });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b px-4 py-4">
        <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <Button
              variant="ghost"
              size="icon"
              asChild
              className="mt-0.5 shrink-0"
            >
              <Link to="/launchpad" aria-label="Back to the Launchpad">
                <ArrowLeft />
              </Link>
            </Button>
            <span className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
              <LaunchpadIconView icon={workspace.icon} />
            </span>
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <div className="min-w-0 max-w-full">
                  <InlineEdit
                    label="Workspace name"
                    value={workspace.title}
                    onSave={(title) => save({ title })}
                    placeholder="Name this workspace"
                    required
                    maxLength={120}
                    autoEdit={fresh}
                    className="w-auto text-xl font-semibold"
                    inputClassName="text-xl font-semibold"
                  />
                </div>
                <PhaseBadge phase={workspace.phase} />
              </div>
              <InlineEdit
                label="Note"
                value={workspace.description}
                onSave={(description) => save({ description })}
                placeholder="Add a note: what is this for?"
                multiline
                maxLength={1000}
                className="text-sm text-muted-foreground"
                inputClassName="text-sm"
              />
              <p className="px-0 text-xs text-muted-foreground">
                Started from {workspace.starterTitle}
              </p>
            </div>
          </div>
          <WorkspaceActions workspace={workspace} />
        </div>
      </div>

      {workspace.phase === "ready" ? (
        <Workbench workspace={workspace} />
      ) : (
        <PhasePanel workspace={workspace} />
      )}
    </div>
  );
}

// ── actions ──────────────────────────────────────────────────────────────

function WorkspaceActions({ workspace }: { workspace: WorkspaceDetail }) {
  const navigate = useNavigate();
  const action = useWorkspaceAction();
  const remove = useDeleteWorkspace();
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const busy = PHASE_PRESENTATION[workspace.phase].busy;
  const pending = (name: "sleep" | "wake" | "retry") =>
    action.isPending && action.variables?.action === name;

  return (
    <div className="flex shrink-0 items-center gap-2 lg:pt-1">
      {workspace.phase === "ready" ? (
        <Button
          variant="outline"
          size="sm"
          loading={pending("sleep")}
          disabled={action.isPending}
          onClick={() => action.mutate({ id: workspace.id, action: "sleep" })}
          title="Frees up resources. Your work is kept."
        >
          <Moon />
          Put to sleep
        </Button>
      ) : null}
      {workspace.phase === "sleeping" ? (
        <Button
          size="sm"
          loading={pending("wake")}
          disabled={action.isPending}
          onClick={() => action.mutate({ id: workspace.id, action: "wake" })}
        >
          <Sunrise />
          Wake up
        </Button>
      ) : null}
      {workspace.phase === "failed" ? (
        <Button
          size="sm"
          loading={pending("retry")}
          disabled={action.isPending}
          onClick={() => action.mutate({ id: workspace.id, action: "retry" })}
        >
          <RotateCw />
          Try again
        </Button>
      ) : null}
      <div className="relative">
        <Button
          variant="ghost"
          size="icon"
          aria-label="More"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
          onBlur={() => setTimeout(() => setMenuOpen(false), 150)}
        >
          <MoreHorizontal />
        </Button>
        {menuOpen ? (
          <div className="absolute right-0 z-30 mt-1 w-52 rounded-md border bg-popover p-1 shadow-md">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setMenuOpen(false);
                setConfirmOpen(true);
              }}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-danger hover:bg-muted disabled:opacity-50"
              title={busy ? "Wait until it has finished starting" : undefined}
            >
              <Trash2 className="size-4" />
              Delete workspace
            </button>
          </div>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Delete this workspace?"
        description={
          <>
            <strong>{workspace.title}</strong> and everything in it will be
            permanently deleted. This can't be undone.
          </>
        }
        onConfirm={() =>
          remove.mutate(workspace.id, {
            onSuccess: () => navigate({ to: "/launchpad" }),
          })
        }
      />
    </div>
  );
}

// ── not ready: a calm, full-width status panel ───────────────────────────

function PhasePanel({ workspace }: { workspace: WorkspaceDetail }) {
  const action = useWorkspaceAction();
  const p = PHASE_PRESENTATION[workspace.phase];
  return (
    <div className="mx-auto grid w-full max-w-5xl flex-1 gap-8 px-4 py-12 lg:grid-cols-[1fr_20rem]">
      <div className="flex flex-col items-center justify-center gap-5 rounded-xl border border-dashed px-6 py-16 text-center">
        {p.busy ? (
          <Loader2 className="size-8 animate-spin text-muted-foreground" />
        ) : workspace.phase === "sleeping" ? (
          <Moon className="size-8 text-muted-foreground" />
        ) : (
          <AlertTriangle className="size-8 text-danger" />
        )}
        <div className="max-w-md space-y-2">
          <h2 className="text-lg font-semibold">
            {workspace.phase === "sleeping"
              ? "This workspace is asleep"
              : p.label}
          </h2>
          <p className="text-sm text-muted-foreground">{p.hint}</p>
          {workspace.phase === "failed" && workspace.error ? (
            <details className="text-left text-xs text-muted-foreground">
              <summary className="cursor-pointer text-center">Details</summary>
              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 font-mono">
                {workspace.error}
              </pre>
            </details>
          ) : null}
        </div>
        {workspace.phase === "sleeping" ? (
          <Button
            size="lg"
            loading={action.isPending}
            onClick={() => action.mutate({ id: workspace.id, action: "wake" })}
          >
            <Sunrise />
            Wake up
          </Button>
        ) : workspace.phase === "failed" ? (
          <Button
            size="lg"
            loading={action.isPending}
            onClick={() => action.mutate({ id: workspace.id, action: "retry" })}
          >
            <RotateCw />
            Try again
          </Button>
        ) : null}
      </div>
      <aside className="space-y-6">
        {workspace.services.length > 0 ? (
          <div className="space-y-2">
            <h3 className="text-sm font-medium text-muted-foreground">
              {p.busy ? "Coming up" : "Your tools"}
            </h3>
            <ul className="space-y-1">
              {workspace.services.map((service) => (
                <li
                  key={service.id}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground"
                >
                  <LaunchpadIconView
                    icon={service.icon}
                    fallback={AppWindow}
                    className="size-4"
                  />
                  {service.label}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <Guide guide={workspace.guide} />
      </aside>
    </div>
  );
}

function Guide({ guide }: { guide?: string }) {
  if (!guide) return null;
  return (
    <div className="space-y-2 rounded-lg border bg-muted/30 p-4">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <BookOpen className="size-4" />
        How to use this
      </h3>
      <p className="whitespace-pre-wrap text-sm text-muted-foreground">
        {guide}
      </p>
    </div>
  );
}

// ── ready: the tools rail + the embedded view ────────────────────────────

/** The first tile to show: the first embeddable service with a url. */
function initialService(services: Service[]): string | undefined {
  return (
    services.find((s) => s.open === "embed" && s.url)?.id ?? services[0]?.id
  );
}

function Workbench({ workspace }: { workspace: WorkspaceDetail }) {
  const { services } = workspace;
  const [selected, setSelected] = useState(() => initialService(services));
  // Frames stay mounted once visited, so switching tools never reloads one
  // (a chat session or a half-filled form survives a detour).
  const [visited, setVisited] = useState<Set<string>>(
    () => new Set(selected ? [selected] : []),
  );
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  function choose(service: Service) {
    if (service.open === "external" && service.url) {
      window.open(service.url, "_blank", "noopener,noreferrer");
      return;
    }
    setSelected(service.id);
    setVisited((prev) => new Set(prev).add(service.id));
  }

  if (services.length === 0) {
    return (
      <div className="mx-auto w-full max-w-5xl flex-1 px-4 py-12">
        <div className="grid gap-8 lg:grid-cols-[1fr_20rem]">
          <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed px-6 py-16 text-center">
            <AppWindow className="size-8 text-muted-foreground" />
            <p className="max-w-sm text-sm text-muted-foreground">
              Your workspace is ready, but no tools were set up for it. Ask your
              tech team to add some to this starter.
            </p>
          </div>
          <Guide guide={workspace.guide} />
        </div>
      </div>
    );
  }

  const current = services.find((s) => s.id === selected);

  return (
    <div className="mx-auto grid w-full max-w-[1600px] flex-1 grid-rows-[auto_1fr] gap-4 p-4 lg:grid-cols-[16rem_1fr] lg:grid-rows-1">
      <aside className="flex min-w-0 flex-col gap-4">
        <nav aria-label="Your tools" className="space-y-1">
          <h2 className="px-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Your tools
          </h2>
          <ul className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible">
            {services.map((service) => (
              <li key={service.id} className="shrink-0 lg:shrink">
                <ServiceTile
                  service={service}
                  active={service.id === selected}
                  onChoose={() => choose(service)}
                />
              </li>
            ))}
          </ul>
        </nav>
        <div className="hidden lg:block">
          <Guide guide={workspace.guide} />
        </div>
      </aside>

      <section
        className={cn(
          "flex min-h-[70vh] min-w-0 flex-col overflow-hidden rounded-xl border bg-card lg:min-h-0",
          fullscreen && "fixed inset-0 z-50 min-h-0 rounded-none border-0",
        )}
      >
        {current ? (
          <FrameToolbar
            service={current}
            fullscreen={fullscreen}
            onToggleFullscreen={() => setFullscreen((f) => !f)}
          />
        ) : null}
        <div className="relative min-h-0 flex-1">
          {services
            .filter((s) => s.open === "embed" && visited.has(s.id))
            .map((service) => (
              <div
                key={service.id}
                className={cn(
                  "absolute inset-0",
                  service.id !== selected && "hidden",
                )}
              >
                <ServiceFrame workspaceId={workspace.id} service={service} />
              </div>
            ))}
          {current && current.open === "external" ? (
            <ExternalNotice service={current} />
          ) : null}
        </div>
      </section>
    </div>
  );
}

function serviceDot(service: Service): {
  variant: "success" | "info" | "neutral" | "danger";
  label: string;
} {
  if (!service.url) return { variant: "danger", label: "Unavailable" };
  if (!service.processes || service.ready) {
    return { variant: "success", label: "Ready" };
  }
  return { variant: "info", label: "Starting" };
}

function ServiceTile({
  service,
  active,
  onChoose,
}: {
  service: Service;
  active: boolean;
  onChoose: () => void;
}) {
  const dot = serviceDot(service);
  return (
    <div
      className={cn(
        "group flex items-center gap-1 rounded-lg transition-colors",
        active ? "bg-muted" : "hover:bg-muted/60",
      )}
    >
      <button
        type="button"
        onClick={onChoose}
        disabled={!service.url}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-2 text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        aria-current={active ? "page" : undefined}
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-background shadow-xs">
          <LaunchpadIconView
            icon={service.icon}
            fallback={AppWindow}
            className="size-4"
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-sm font-medium">
            <span className="truncate">{service.label}</span>
            {service.open === "external" ? (
              <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
            ) : null}
          </span>
          {service.description ? (
            <span className="hidden truncate text-xs text-muted-foreground lg:block">
              {service.description}
            </span>
          ) : null}
        </span>
        <StatusDot
          variant={dot.variant}
          pulse={dot.label === "Starting"}
          className="mr-1"
        />
        <span className="sr-only">{dot.label}</span>
      </button>
    </div>
  );
}

function FrameToolbar({
  service,
  fullscreen,
  onToggleFullscreen,
}: {
  service: Service;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
}) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
      <LaunchpadIconView
        icon={service.icon}
        fallback={AppWindow}
        className="size-4 text-muted-foreground"
      />
      <span className="truncate text-sm font-medium">{service.label}</span>
      <div className="flex-1" />
      {service.url ? (
        <Button
          variant="ghost"
          size="sm"
          asChild
          title="Page blank? Some tools only work in their own tab."
        >
          <a href={service.url} target="_blank" rel="noreferrer">
            <ExternalLink />
            <span className="hidden sm:inline">Open in a new tab</span>
          </a>
        </Button>
      ) : null}
      {service.open === "embed" ? (
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={onToggleFullscreen}
          aria-label={fullscreen ? "Exit full screen" : "Full screen"}
          title={fullscreen ? "Exit full screen (Esc)" : "Full screen"}
        >
          {fullscreen ? <Minimize2 /> : <Maximize2 />}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * One embedded tool. The iframe mounts only once the tool's processes report
 * ready (plus a short grace), never earlier: an early mount is what lands on
 * a blank "Bad Gateway". The server already started the tool at launch, so
 * the manual start is a quiet fallback, not the main path.
 */
function ServiceFrame({
  workspaceId,
  service,
}: {
  workspaceId: string;
  service: Service;
}) {
  const start = useStartServiceProcesses(workspaceId);
  const gate = useServiceGate(workspaceId, service, {
    startProcesses: (names) => start.mutate(names),
  });
  const [reloadKey, setReloadKey] = useState(0);
  // The server starts declared tools right after the workspace comes up, so
  // a "Start" button would only confuse at first. Offer it as a fallback
  // once the tool has taken unusually long.
  const [patient, setPatient] = useState(true);
  useEffect(() => {
    if (gate.canMount) return;
    const timer = setTimeout(() => setPatient(false), 20_000);
    return () => clearTimeout(timer);
  }, [gate.canMount]);

  if (!service.url) {
    return (
      <CenteredNote icon={AlertTriangle}>
        {service.label} isn't available in this workspace. Ask your tech team to
        check this starter.
      </CenteredNote>
    );
  }

  if (!gate.canMount) {
    return (
      <CenteredNote icon={Loader2} spin>
        <span className="block">Getting {service.label} ready…</span>
        {!patient ? (
          <Button
            variant="outline"
            size="sm"
            className="mt-4"
            loading={gate.starting}
            onClick={() => gate.start()}
          >
            <Play />
            Start {service.label}
          </Button>
        ) : null}
      </CenteredNote>
    );
  }

  return (
    <div className="relative h-full w-full">
      <iframe
        key={reloadKey}
        src={service.url}
        title={service.label}
        allow="clipboard-read; clipboard-write; fullscreen"
        className="h-full w-full border-0 bg-background"
      />
      <Button
        variant="secondary"
        size="icon"
        className="absolute right-3 bottom-3 size-8 opacity-60 shadow-sm hover:opacity-100"
        onClick={() => setReloadKey((k) => k + 1)}
        aria-label={`Reload ${service.label}`}
        title="Reload"
      >
        <RotateCw className="size-3.5" />
      </Button>
    </div>
  );
}

function ExternalNotice({ service }: { service: Service }) {
  return (
    <CenteredNote icon={ExternalLink}>
      <span className="block">{service.label} opens in its own tab.</span>
      {service.url ? (
        <Button size="sm" className="mt-4" asChild>
          <a href={service.url} target="_blank" rel="noreferrer">
            Open {service.label}
          </a>
        </Button>
      ) : null}
    </CenteredNote>
  );
}

function CenteredNote({
  icon: Icon,
  spin,
  children,
}: {
  icon: typeof Loader2;
  spin?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-muted/20 px-6 text-center">
      <Icon
        className={cn("size-7 text-muted-foreground", spin && "animate-spin")}
      />
      <div className="max-w-sm text-sm text-muted-foreground">{children}</div>
    </div>
  );
}
