import { useQuery } from "@tanstack/react-query";
import { Bookmark, Loader2, Plus, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  terminalSessionsQuery,
  useCreateTerminalSession,
  useDeleteTerminalSession,
} from "@/api/queries/terminal";
import {
  TerminalView,
  type TerminalViewHandle,
} from "@/components/terminal-view";
import { cn } from "@/lib/utils";

/**
 * A tabbed terminal multiplexer for a sandbox: one tab per terminal session.
 * Every session's {@link TerminalView} stays mounted (inactive ones hidden),
 * so switching tabs preserves each session's live PTY connection and
 * scrollback. Creating selects the new tab; closing a session removes it.
 */
export function MultiTerminal({
  sandboxId,
  className,
}: {
  sandboxId: string;
  className?: string;
}) {
  const {
    data: sessions,
    isPending,
    isError,
    error,
  } = useQuery(terminalSessionsQuery(sandboxId));
  const create = useCreateTerminalSession(sandboxId);
  const remove = useDeleteTerminalSession(sandboxId);
  const [activeId, setActiveId] = useState<string | null>(null);
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

  if (isPending) {
    return (
      <div
        className={cn(
          "flex h-96 items-center justify-center rounded-md border bg-card",
          className,
        )}
      >
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isError) {
    return (
      <div
        className={cn(
          "flex h-96 items-center justify-center rounded-md border bg-card px-4 text-center text-sm text-muted-foreground",
          className,
        )}
      >
        {error instanceof Error ? error.message : "Terminal unavailable"}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex h-96 flex-col overflow-hidden rounded-md border bg-card",
        className,
      )}
    >
      <div className="flex items-center overflow-x-auto border-b bg-elevated/50">
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
              className="max-w-[140px] truncate"
              onClick={() => setActiveId(session.id)}
            >
              {session.title || session.id}
            </button>
            <button
              type="button"
              aria-label="Close terminal"
              className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
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
            <p className="text-sm">No terminal sessions</p>
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm text-foreground hover:bg-elevated disabled:opacity-50"
              disabled={create.isPending}
              onClick={createSession}
            >
              {create.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Plus className="size-4" />
              )}
              New terminal
            </button>
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
                className="h-full"
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
}
