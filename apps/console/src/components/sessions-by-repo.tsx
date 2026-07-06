import type { AgentSession, AgentSessionStatus } from "@frak/atelier-shared";
import { useQuery } from "@tanstack/react-query";
import { FolderGit2, Maximize2, Square, Trash2 } from "lucide-react";
import { useState } from "react";
import { sessionTodosQuery } from "@/api/queries/sessions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot } from "@/components/ui/status-dot";
import { formatRelativeTime, repoLabel } from "@/lib/formatters";
import {
  sessionStatusPresentation,
  summarizeTodos,
  todoIcon,
} from "@/lib/status-presentation";

/** Groups a flat session list by `directory` (the cloned git repo). Sorted by
 * most-recently-updated session within each group; repos with the most
 * recent activity float to the top. */
function groupSessionsByRepo(
  sessions: AgentSession[],
): [string, AgentSession[]][] {
  const groups = new Map<string, AgentSession[]>();
  for (const session of sessions) {
    const list = groups.get(session.directory) ?? [];
    list.push(session);
    groups.set(session.directory, list);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => b.time.updated - a.time.updated);
  }
  return [...groups.entries()].sort(
    ([, a], [, b]) => (b[0]?.time.updated ?? 0) - (a[0]?.time.updated ?? 0),
  );
}

/**
 * Renders sessions grouped by repo (directory). A repo group with zero
 * sessions is simply absent from `sessions` upstream, so there is nothing to
 * hide here — callers just don't pass empty groups in.
 */
export function SessionsByRepo({
  sessions,
  statuses,
  onAbort,
  onDelete,
  onOpen,
  abortingId,
  deletingId,
}: {
  sessions: AgentSession[];
  statuses: Record<string, AgentSessionStatus> | undefined;
  onAbort: (session: AgentSession) => void;
  onDelete: (session: AgentSession) => void;
  onOpen: (session: AgentSession) => void;
  abortingId?: string;
  deletingId?: string;
}) {
  const groups = groupSessionsByRepo(sessions);

  return (
    <div className="space-y-4">
      {groups.map(([directory, groupSessions]) => (
        <div key={directory} className="space-y-2">
          <div className="flex items-baseline gap-2">
            <FolderGit2 className="size-4 shrink-0 self-center text-muted-foreground" />
            <span className="font-medium">{repoLabel(directory)}</span>
            <span className="truncate font-mono text-xs text-muted-foreground">
              {directory}
            </span>
          </div>
          <div className="space-y-2">
            {groupSessions.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                status={statuses?.[session.id]}
                onAbort={() => onAbort(session)}
                onDelete={() => onDelete(session)}
                onOpen={() => onOpen(session)}
                aborting={abortingId === session.id}
                deleting={deletingId === session.id}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function SessionRow({
  session,
  status,
  onAbort,
  onDelete,
  onOpen,
  aborting,
  deleting,
}: {
  session: AgentSession;
  status: AgentSessionStatus | undefined;
  onAbort: () => void;
  onDelete: () => void;
  onOpen: () => void;
  aborting: boolean;
  deleting: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const presentation = sessionStatusPresentation(status);
  // Eager for busy sessions (plan §1.2): the todo summary is worth the fetch
  // since it's the most likely thing to have changed. Idle sessions fetch
  // lazily, only once expanded — the toggle below is always rendered (not
  // gated on already having a summary), otherwise an idle session could never
  // trigger its own first fetch.
  const shouldFetchTodos = status?.type === "busy" || expanded;
  const { data: todos, isPending: todosPending } = useQuery({
    ...sessionTodosQuery(session.sandboxId, session.id),
    enabled: shouldFetchTodos,
  });
  const summary = todos ? summarizeTodos(todos) : null;

  return (
    <div className="rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusDot
          variant={presentation.dotVariant}
          pulse={presentation.pulse}
        />
        <span className="truncate font-medium">
          {session.title || "Untitled"}
        </span>
        <Badge variant={presentation.badgeVariant}>{presentation.label}</Badge>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          {formatRelativeTime(new Date(session.time.updated).toISOString())}
        </span>
      </div>

      {shouldFetchTodos && todosPending ? (
        <p className="mt-1 text-sm text-muted-foreground">Loading todos…</p>
      ) : summary ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 block text-left text-sm text-muted-foreground hover:text-foreground"
        >
          ▸ {summary}
        </button>
      ) : !expanded ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-1 block text-left text-sm text-muted-foreground hover:text-foreground"
        >
          ▸ Show todos
        </button>
      ) : todos && todos.length === 0 ? (
        <p className="mt-1 text-sm text-muted-foreground">No todos.</p>
      ) : null}

      {expanded && todos && todos.length > 0 ? (
        <ul className="mt-2 space-y-1 border-t pt-2 text-sm">
          {todos.map((todo, index) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: todos have no id; list re-fetched wholesale
              key={index}
              className={
                todo.status === "completed" || todo.status === "cancelled"
                  ? "flex items-start gap-2 text-muted-foreground line-through"
                  : "flex items-start gap-2"
              }
            >
              <span className="font-mono">{todoIcon(todo.status)}</span>
              <span>{todo.content}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-2 flex gap-2">
        <Button size="sm" variant="outline" onClick={onOpen}>
          <Maximize2 />
          Open
        </Button>
        {status?.type === "busy" ? (
          <Button
            size="sm"
            variant="outline"
            loading={aborting}
            onClick={onAbort}
          >
            <Square />
            Abort
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          loading={deleting}
          onClick={onDelete}
        >
          <Trash2 />
          Delete
        </Button>
      </div>
    </div>
  );
}

export function SessionsByRepoSkeleton() {
  return (
    <div className="space-y-2">
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-16 w-full" />
    </div>
  );
}
