import type { SandboxStatus } from "@atelier/spec";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bookmark, Loader2, Plus, RotateCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { queryKeys } from "@/api/queries/keys";
import {
  terminalSessionsQuery,
  useCreateTerminalSession,
  useDeleteTerminalSession,
} from "@/api/queries/terminal";
import {
  type TerminalProgress,
  TerminalView,
  type TerminalViewHandle,
} from "@/components/terminal-view";
import { StatusDot } from "@/components/ui/status-dot";
import { cn } from "@/lib/utils";

/** Sandboxes that got a terminal opened when their boot finished. The inline
 * panel and the immersive view can both be watching the same boot, and one
 * terminal is enough. */
const openedOnBoot = new Set<string>();

/**
 * A tabbed terminal multiplexer for a sandbox: one tab per terminal session.
 * Every session's {@link TerminalView} stays mounted (inactive ones hidden),
 * so switching tabs preserves each session's live PTY connection and
 * scrollback. Creating selects the new tab; closing a session removes it.
 * A tab shows the progress its app reports (OSC 9;4), so a busy agent in a
 * background tab is visible at a glance.
 *
 * Sessions live in the sandbox's agent, so nothing is listed until the
 * sandbox runs. A view that waits through a boot or a resume lists the
 * sessions once the sandbox is up and opens a terminal if there is none.
 * A session whose connection closes is listed again, so a shell that exited
 * (`exit`, Ctrl+D) loses its tab.
 */
export function MultiTerminal({
  sandboxId,
  status,
  className,
}: {
  sandboxId: string;
  status: SandboxStatus;
  className?: string;
}) {
  const running = status === "running";
  const queryClient = useQueryClient();
  const {
    data: sessions,
    isPending,
    isError,
    isFetching,
    error,
    refetch,
  } = useQuery({ ...terminalSessionsQuery(sandboxId), enabled: running });
  const create = useCreateTerminalSession(sandboxId);
  const remove = useDeleteTerminalSession(sandboxId);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, TerminalProgress>>(
    {},
  );
  const activeHandleRef = useRef<TerminalViewHandle | null>(null);

  const list = sessions ?? [];

  // Keep a valid tab selected as sessions are created/closed elsewhere.
  useEffect(() => {
    setActiveId((current) => {
      if (list.length === 0) return null;
      if (current && list.some((s) => s.id === current)) return current;
      return list[0]?.id ?? null;
    });
  }, [list]);

  const createSession = useCallback(() => {
    create.mutate({}, { onSuccess: (data) => data && setActiveId(data.id) });
  }, [create]);

  const relist = useCallback(() => {
    queryClient.invalidateQueries({
      queryKey: queryKeys.terminal.all(sandboxId),
    });
  }, [queryClient, sandboxId]);

  const waitedForBoot = useRef(!running);
  useEffect(() => {
    if (running) return;
    waitedForBoot.current = true;
    openedOnBoot.delete(sandboxId);
    // Sessions die with the pod on pause: drop the cached list so a resume
    // lists afresh instead of reattaching to dead sessions.
    queryClient.resetQueries({ queryKey: queryKeys.terminal.all(sandboxId) });
  }, [running, sandboxId, queryClient]);

  useEffect(() => {
    if (!running || !sessions || !waitedForBoot.current) return;
    waitedForBoot.current = false;
    if (sessions.length > 0 || openedOnBoot.has(sandboxId)) return;
    openedOnBoot.add(sandboxId);
    createSession();
  }, [running, sessions, sandboxId, createSession]);

  if (!running) {
    return (
      <TerminalPlaceholder className={className}>
        <NotRunning status={status} />
      </TerminalPlaceholder>
    );
  }

  if (isPending) {
    return (
      <TerminalPlaceholder className={className}>
        <Loader2 className="size-5 animate-spin" />
      </TerminalPlaceholder>
    );
  }

  if (isError) {
    return (
      <TerminalPlaceholder className={className}>
        <p className="text-sm">
          {error instanceof Error ? error.message : "Terminal unavailable"}
        </p>
        <PlaceholderButton disabled={isFetching} onClick={() => refetch()}>
          {isFetching ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RotateCw className="size-4" />
          )}
          Retry
        </PlaceholderButton>
      </TerminalPlaceholder>
    );
  }

  return (
    <div
      className={cn(
        "flex h-96 flex-col overflow-hidden rounded-md border bg-card",
        className,
      )}
    >
      <div
        role="tablist"
        aria-label="Terminals"
        className="flex items-center overflow-x-auto border-b bg-elevated/50"
      >
        {list.map((session) => (
          <div
            key={session.id}
            className={cn(
              "group flex shrink-0 items-center gap-1 border-r py-1.5 pr-1 pl-3 text-sm transition-colors",
              session.id === activeId
                ? "bg-card text-foreground"
                : "text-muted-foreground hover:bg-elevated/50 hover:text-foreground",
            )}
          >
            <button
              type="button"
              role="tab"
              aria-selected={session.id === activeId}
              className="flex max-w-[160px] items-center gap-1.5"
              onClick={() => setActiveId(session.id)}
            >
              <TabProgress progress={progress[session.id]} />
              <span className="truncate">{session.title || session.id}</span>
            </button>
            <button
              type="button"
              aria-label="Close terminal"
              className="rounded p-1.5 text-muted-foreground opacity-100 transition-opacity hover:text-danger focus-visible:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100"
              disabled={remove.isPending}
              onClick={() => {
                // Advance to an adjacent tab immediately so the pane never
                // flashes blank while the delete refetch is in flight.
                setActiveId((cur) =>
                  cur === session.id
                    ? (list.find((s) => s.id !== session.id)?.id ?? null)
                    : cur,
                );
                remove.mutate(session.id);
              }}
            >
              <X className="size-3.5" />
            </button>
          </div>
        ))}
        <button
          type="button"
          aria-label="New terminal"
          className="flex shrink-0 items-center px-2 py-1.5 text-muted-foreground hover:text-foreground disabled:opacity-50"
          disabled={create.isPending}
          onClick={createSession}
        >
          {create.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Plus className="size-4" />
          )}
        </button>
        {activeId ? (
          <button
            type="button"
            aria-label="Mark this point in the terminal"
            title="Mark this point in the terminal"
            className="ml-auto flex shrink-0 items-center gap-1 px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => activeHandleRef.current?.mark()}
          >
            <Bookmark className="size-3.5" />
            Mark
          </button>
        ) : null}
      </div>

      <div className="relative min-h-0 flex-1">
        {list.length === 0 ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-muted-foreground">
            <p className="text-sm">
              {create.isPending
                ? "Opening a terminal…"
                : "No terminal sessions"}
            </p>
            <PlaceholderButton
              disabled={create.isPending}
              onClick={createSession}
            >
              {create.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Plus className="size-4" />
              )}
              New terminal
            </PlaceholderButton>
          </div>
        ) : (
          list.map((session) => (
            <div
              key={session.id}
              className={cn(
                "absolute inset-0",
                session.id !== activeId && "hidden",
              )}
            >
              <TerminalView
                ref={session.id === activeId ? activeHandleRef : null}
                wsPath={`/sessions/sandboxes/${sandboxId}/terminal/sessions/${session.id}/ws`}
                active={session.id === activeId}
                onProgress={(next) =>
                  setProgress((prev) => ({ ...prev, [session.id]: next }))
                }
                onDisconnect={relist}
                className="h-full"
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** The pane shown instead of the tabs: same frame, centred content. */
function TerminalPlaceholder({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex h-96 flex-col items-center justify-center gap-3 rounded-md border bg-card px-4 text-center text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
  );
}

function PlaceholderButton(props: React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm text-foreground hover:bg-elevated disabled:opacity-50"
      {...props}
    />
  );
}

/** Why there is no terminal yet. A boot is waited out with a spinner: the
 * pane switches to the terminal by itself once the sandbox runs. */
function NotRunning({ status }: { status: SandboxStatus }) {
  switch (status) {
    case "creating":
      return (
        <>
          <Loader2 className="size-5 animate-spin" />
          <p className="text-sm">
            Starting the sandbox. The terminal opens once it is running.
          </p>
        </>
      );
    case "paused":
      return (
        <p className="text-sm">
          The sandbox is paused. Resume it to use the terminal.
        </p>
      );
    case "error":
      return (
        <p className="text-sm">
          The sandbox failed, so there is no terminal to open.
        </p>
      );
    default:
      return (
        <p className="text-sm">
          The sandbox is not running, so there is no terminal to open.
        </p>
      );
  }
}

/**
 * A tab's OSC 9;4 progress: a spinner while working (with the percentage
 * when the app reports one), a dot for error or paused, nothing when idle.
 */
function TabProgress({ progress }: { progress?: TerminalProgress }) {
  switch (progress?.state) {
    case 1:
      return (
        <span
          className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground tabular-nums"
          title={`${progress.value}%`}
        >
          <Loader2 className="size-3 animate-spin" />
          {progress.value}%
        </span>
      );
    case 3:
      return (
        <span className="shrink-0" title="Working">
          <Loader2 className="size-3 animate-spin text-muted-foreground" />
        </span>
      );
    case 2:
      return (
        <span className="flex shrink-0" title="Error">
          <StatusDot variant="danger" />
        </span>
      );
    case 4:
      return (
        <span className="flex shrink-0" title="Paused">
          <StatusDot variant="warning" />
        </span>
      );
    default:
      return null;
  }
}
