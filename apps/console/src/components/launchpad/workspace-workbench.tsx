import {
  AlertTriangle,
  AppWindow,
  ExternalLink,
  Loader2,
  Maximize2,
  Minimize2,
  Play,
  RotateCw,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import {
  useStartServiceProcesses,
  type WorkspaceDetail,
} from "@/api/queries/launchpad";
import { WorkspaceGuide } from "@/components/launchpad/workspace-guide";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-dot";
import { useServiceGate } from "@/hooks/use-service-gate";
import { LaunchpadIconView } from "@/lib/launchpad";
import { cn } from "@/lib/utils";

type Service = WorkspaceDetail["services"][number];

/** Every capability except top-level navigation (and plugins). */
const FRAME_SANDBOX = [
  "allow-scripts",
  "allow-same-origin",
  "allow-forms",
  "allow-modals",
  "allow-popups",
  "allow-popups-to-escape-sandbox",
  "allow-downloads",
].join(" ");

/** The first tile to show: the first embeddable service with a url. */
function initialService(services: Service[]): string | undefined {
  return (
    services.find((s) => s.open === "embed" && s.url)?.id ?? services[0]?.id
  );
}

/**
 * Ready: the tools rail beside the embedded view. Frames mount only once a
 * tool reports ready and then stay mounted, so switching tools never reloads
 * one (a chat session or a half-filled form survives a detour).
 */
export function WorkspaceWorkbench({
  workspace,
}: {
  workspace: WorkspaceDetail;
}) {
  const { services } = workspace;
  const [selected, setSelected] = useState(() => initialService(services));
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
          <WorkspaceGuide guide={workspace.guide} />
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
          <WorkspaceGuide guide={workspace.guide} />
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
        // Starters can point a tool at any URL, shown to people who can't
        // judge it: never let a frame navigate the Launchpad itself away.
        // Everything a web app needs stays allowed (same-origin is its own
        // origin, not ours: tools live on their own hosts).
        sandbox={FRAME_SANDBOX}
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
