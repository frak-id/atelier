import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  Bot,
  Columns2,
  Globe,
  Loader2,
  Monitor,
  Pause,
  Play,
  RotateCcw,
  Square,
  Terminal,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Sandbox } from "@/api/client";
import {
  deriveBrowserStatus,
  sandboxDetailQuery,
  sandboxServicesQuery,
  useRestartSandbox,
  useStartBrowser,
  useStartSandbox,
  useStopSandbox,
  workspaceDetailQuery,
} from "@/api/queries";
import { TerminalEmulator } from "@/components/terminal-emulator";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/sandboxes/$id")({
  component: SandboxImmersionPage,
  loader: ({ context, params }) => {
    context.queryClient.ensureQueryData(sandboxDetailQuery(params.id));
  },
  pendingComponent: ImmersionSkeleton,
});

const statusVariant = {
  running: "success",
  creating: "warning",
  stopped: "secondary",
  error: "error",
} as const;

type TabId = "opencode" | "vscode" | "terminal" | "web";

const tabs: { id: TabId; label: string; icon: typeof Monitor }[] = [
  { id: "opencode", label: "OpenCode", icon: Bot },
  { id: "vscode", label: "VSCode", icon: Monitor },
  { id: "terminal", label: "Terminal", icon: Terminal },
  { id: "web", label: "Web", icon: Globe },
];

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia("(max-width: 768px)");
    setIsMobile(mql.matches);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);
  return isMobile;
}

function SandboxImmersionPage() {
  const { id } = Route.useParams();
  const { data: sandbox } = useSuspenseQuery(sandboxDetailQuery(id));
  const { data: workspace } = useQuery({
    ...workspaceDetailQuery(sandbox?.workspaceId ?? ""),
    enabled: !!sandbox?.workspaceId,
  });

  const isMobile = useIsMobile();

  const { data: services } = useQuery({
    ...sandboxServicesQuery(id),
    enabled: sandbox?.status === "running",
    refetchInterval: 2000,
    refetchIntervalInBackground: false,
  });
  const startBrowserMutation = useStartBrowser(id);

  const browserStatus = deriveBrowserStatus(services, sandbox);
  const browserUrl = browserStatus?.url
    ? `${browserStatus.url}/?autoconnect=true&resize=remote`
    : undefined;

  const [activeTab, setActiveTab] = useState<TabId>("opencode");
  const [splitOpen, setSplitOpen] = useState(!isMobile);
  const [rightTab, setRightTab] = useState<"vscode" | "terminal" | "web">(
    "vscode",
  );

  useEffect(() => {
    if (isMobile) setSplitOpen(false);
  }, [isMobile]);

  const handleTabClick = useCallback(
    (tabId: TabId) => {
      if (tabId === "web" && browserStatus?.status === "off") {
        startBrowserMutation.mutate();
      }

      if (isMobile) {
        setActiveTab(tabId);
        return;
      }

      if (tabId === "opencode") {
        if (splitOpen && activeTab === "opencode") {
          setSplitOpen(false);
        } else if (!splitOpen && activeTab === "opencode") {
          setSplitOpen(true);
        } else {
          setActiveTab("opencode");
        }
      } else if (splitOpen) {
        if (rightTab === tabId) {
          // Active right tab clicked again → collapse to single
          setSplitOpen(false);
          setActiveTab(tabId);
        } else {
          setRightTab(tabId);
        }
      } else if (activeTab === tabId) {
        // Active single tab clicked again → expand to split
        setSplitOpen(true);
        setRightTab(tabId);
      } else {
        setActiveTab(tabId);
      }
    },
    [
      isMobile,
      splitOpen,
      activeTab,
      rightTab,
      browserStatus?.status,
      startBrowserMutation,
    ],
  );

  const toggleLayout = useCallback(() => {
    if (isMobile) return;
    setSplitOpen((prev) => {
      if (!prev && activeTab !== "opencode") {
        setRightTab(activeTab as "vscode" | "terminal" | "web");
      }
      return !prev;
    });
  }, [isMobile, activeTab]);

  const isTabActive = (tabId: TabId): boolean => {
    if (splitOpen) {
      return tabId === "opencode" || tabId === rightTab;
    }
    return tabId === activeTab;
  };

  const stopMutation = useStopSandbox();
  const startMutation = useStartSandbox();
  const restartMutation = useRestartSandbox();

  if (!sandbox) {
    return (
      <div className="fixed inset-0 z-50 bg-background flex items-center justify-center">
        <p className="text-muted-foreground">Sandbox not found.</p>
      </div>
    );
  }

  const isRunning = sandbox.status === "running";

  return (
    <div className="fixed inset-0 z-50 bg-background flex flex-col">
      <div className="h-12 border-b bg-card flex items-center px-4 gap-3 shrink-0">
        <Link
          to="/sandboxes"
          className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>

        <div className="flex items-center gap-2 min-w-0">
          <span className="font-mono text-sm truncate">{sandbox.id}</span>
          <Badge variant={statusVariant[sandbox.status]} className="capitalize">
            {sandbox.status}
          </Badge>
          {workspace && (
            <span className="text-sm text-muted-foreground truncate hidden sm:inline">
              {workspace.name}
            </span>
          )}
        </div>

        <div className="flex-1" />
        {isRunning ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => stopMutation.mutate(id)}
              disabled={stopMutation.isPending}
              className="h-8"
            >
              {stopMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
              ) : (
                <Pause className="h-4 w-4 mr-1.5" />
              )}
              <span className="hidden sm:inline">Stop</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => restartMutation.mutate(id)}
              disabled={restartMutation.isPending}
              className="h-8"
            >
              {restartMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
              ) : (
                <RotateCcw className="h-4 w-4 mr-1.5" />
              )}
              <span className="hidden sm:inline">Restart</span>
            </Button>
          </>
        ) : sandbox.status === "stopped" ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => startMutation.mutate(id)}
            disabled={startMutation.isPending}
            className="h-8"
          >
            {startMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
            ) : (
              <Play className="h-4 w-4 mr-1.5" />
            )}
            <span className="hidden sm:inline">Start</span>
          </Button>
        ) : null}

        {isRunning && (
          <div className="w-px h-6 bg-border shrink-0 hidden sm:block" />
        )}

        {isRunning && (
          <div className="flex items-center gap-1">
            {tabs.map((tab) => (
              <Tooltip key={tab.id}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => handleTabClick(tab.id)}
                    className={cn(
                      "flex items-center gap-1.5 px-2.5 h-8 rounded-md text-sm transition-colors",
                      isTabActive(tab.id)
                        ? "bg-accent text-accent-foreground"
                        : "text-muted-foreground hover:text-foreground hover:bg-muted",
                    )}
                  >
                    <tab.icon className="h-4 w-4" />
                    <span className="hidden lg:inline">{tab.label}</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent className="lg:hidden">
                  {tab.label}
                </TooltipContent>
              </Tooltip>
            ))}

            {!isMobile && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={toggleLayout}
                    className={cn(
                      "flex items-center gap-1.5 px-2 h-8 rounded-md text-sm transition-colors ml-1",
                      "text-muted-foreground hover:text-foreground hover:bg-muted",
                    )}
                  >
                    {splitOpen ? (
                      <Square className="h-4 w-4" />
                    ) : (
                      <Columns2 className="h-4 w-4" />
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  {splitOpen ? "Single view" : "Split view"}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        )}
      </div>

      {isRunning ? (
        <ImmersionContent
          sandbox={sandbox}
          splitOpen={splitOpen}
          activeTab={activeTab}
          rightTab={rightTab}
          browserUrl={browserUrl}
          browserStarting={browserStatus?.status === "starting"}
        />
      ) : (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-4">
            <p className="text-muted-foreground">
              Sandbox is not running. Start it to access the immersion view.
            </p>
            {sandbox.status === "stopped" && (
              <Button
                onClick={() => startMutation.mutate(id)}
                disabled={startMutation.isPending}
              >
                {startMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ) : (
                  <Play className="h-4 w-4 mr-2" />
                )}
                Start Sandbox
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const STORAGE_KEY = "sandbox-immersion-split";
const DEFAULT_SPLIT = 40;
const MIN_SPLIT = 25;
const MAX_SPLIT = 75;

function useSplitResize() {
  const [splitPercent, setSplitPercent] = useState(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? Number(stored) : DEFAULT_SPLIT;
  });
  const dividerRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const divider = dividerRef.current;
    const container = containerRef.current;
    if (!divider || !container) return;

    e.preventDefault();
    divider.setPointerCapture(e.pointerId);

    const containerRect = container.getBoundingClientRect();

    const onPointerMove = (ev: PointerEvent) => {
      const x = ev.clientX - containerRect.left;
      const pct = Math.min(
        MAX_SPLIT,
        Math.max(MIN_SPLIT, (x / containerRect.width) * 100),
      );
      setSplitPercent(pct);
    };

    const onPointerUp = () => {
      divider.releasePointerCapture(e.pointerId);
      divider.removeEventListener("pointermove", onPointerMove);
      divider.removeEventListener("pointerup", onPointerUp);
      setSplitPercent((current) => {
        localStorage.setItem(STORAGE_KEY, String(current));
        return current;
      });
    };

    divider.addEventListener("pointermove", onPointerMove);
    divider.addEventListener("pointerup", onPointerUp);
  }, []);

  return { splitPercent, dividerRef, containerRef, onPointerDown };
}

function ImmersionContent({
  sandbox,
  splitOpen,
  activeTab,
  rightTab,
  browserUrl,
  browserStarting,
}: {
  sandbox: Sandbox;
  splitOpen: boolean;
  activeTab: TabId;
  rightTab: "vscode" | "terminal" | "web";
  browserUrl?: string;
  browserStarting?: boolean;
}) {
  const { splitPercent, dividerRef, containerRef, onPointerDown } =
    useSplitResize();

  const urlMap: Record<TabId, string | undefined> = {
    opencode: sandbox.runtime.urls.opencode,
    vscode: sandbox.runtime.urls.vscode,
    terminal: undefined,
    web: browserUrl,
  };

  if (!splitOpen) {
    return (
      <div className="flex-1 relative">
        {tabs.map((tab) => {
          if (tab.id === "terminal") {
            return (
              <div
                key={tab.id}
                className={cn(
                  "absolute inset-0",
                  tab.id !== activeTab && "hidden",
                )}
              >
                <TerminalEmulator
                  sandboxId={sandbox.id}
                  className="w-full h-full"
                />
              </div>
            );
          }
          const url = urlMap[tab.id];
          if (!url) {
            return (
              <div
                key={tab.id}
                className={cn(
                  "absolute inset-0 flex items-center justify-center bg-muted/30",
                  tab.id !== activeTab && "hidden",
                )}
              >
                <div className="text-center space-y-3">
                  <Globe className="h-8 w-8 mx-auto text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">
                    {browserStarting
                      ? "Browser is starting..."
                      : "Click to start browser"}
                  </p>
                  {browserStarting && (
                    <Loader2 className="h-5 w-5 animate-spin mx-auto text-muted-foreground" />
                  )}
                </div>
              </div>
            );
          }

          return (
            <iframe
              key={tab.id}
              src={url}
              className={cn(
                "absolute inset-0 w-full h-full border-0",
                tab.id !== activeTab && "hidden",
              )}
              title={tab.label}
              allow={tab.id === "web" ? "clipboard-write" : undefined}
            />
          );
        })}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex-1 flex min-h-0">
      <div style={{ width: `${splitPercent}%` }} className="min-w-0">
        <iframe
          src={urlMap.opencode}
          className="w-full h-full border-0"
          title="OpenCode"
        />
      </div>

      <div
        ref={dividerRef}
        onPointerDown={onPointerDown}
        className="w-2 shrink-0 cursor-col-resize bg-transparent hover:bg-border/50 active:bg-border transition-colors flex items-center justify-center select-none touch-none"
      >
        <div className="w-1 h-8 rounded-full bg-border" />
      </div>

      <div className="flex-1 min-w-0 relative">
        {(["vscode", "terminal", "web"] as const).map((tabId) => {
          if (tabId === "terminal") {
            return (
              <div
                key={tabId}
                className={cn(
                  "absolute inset-0",
                  rightTab !== tabId && "hidden",
                )}
              >
                <TerminalEmulator
                  sandboxId={sandbox.id}
                  className="w-full h-full"
                />
              </div>
            );
          }
          const url = urlMap[tabId];
          if (!url) {
            return (
              <div
                key={tabId}
                className={cn(
                  "absolute inset-0 flex items-center justify-center bg-muted/30",
                  rightTab !== tabId && "hidden",
                )}
              >
                <div className="text-center space-y-3">
                  <Globe className="h-8 w-8 mx-auto text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">
                    {browserStarting
                      ? "Browser is starting..."
                      : "Click to start browser"}
                  </p>
                  {browserStarting && (
                    <Loader2 className="h-5 w-5 animate-spin mx-auto text-muted-foreground" />
                  )}
                </div>
              </div>
            );
          }
          return (
            <iframe
              key={tabId}
              src={url}
              className={cn(
                "absolute inset-0 w-full h-full border-0",
                rightTab !== tabId && "hidden",
              )}
              title={tabId === "vscode" ? "VSCode" : "Web"}
              allow={tabId === "web" ? "clipboard-write" : undefined}
            />
          );
        })}
      </div>
    </div>
  );
}

function ImmersionSkeleton() {
  return (
    <div className="fixed inset-0 z-50 bg-background flex flex-col">
      <div className="h-12 border-b bg-card flex items-center px-4 gap-3">
        <Skeleton className="h-4 w-4" />
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-5 w-16" />
        <div className="flex-1" />
        <Skeleton className="h-8 w-20" />
        <Skeleton className="h-8 w-20" />
      </div>
      <div className="flex-1 flex">
        <Skeleton className="flex-1" />
      </div>
    </div>
  );
}
