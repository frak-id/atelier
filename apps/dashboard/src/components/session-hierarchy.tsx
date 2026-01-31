import {
  AlertTriangle,
  CheckCircle,
  ChevronRight,
  Clock,
  ExternalLink,
  Loader2,
} from "lucide-react";
import { memo, useMemo } from "react";
import { ExpandableTodoList } from "@/components/expandable-todo-list";
import { SessionStatusIndicator } from "@/components/session-status-indicator";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { SessionInteractionState } from "@/hooks/use-task-session-progress";
import type { SessionNode } from "@/lib/session-hierarchy";
import { buildOpenCodeSessionUrl, cn } from "@/lib/utils";

function collectAllSessionIds(node: SessionNode): Set<string> {
  const ids = new Set<string>([node.session.id]);
  for (const child of node.children) {
    for (const id of collectAllSessionIds(child)) {
      ids.add(id);
    }
  }
  return ids;
}

function computeNodeSummary(
  node: SessionNode,
  interactions: SessionInteractionState[],
) {
  const allIds = collectAllSessionIds(node);
  const nodeInteractions = interactions.filter((i) => allIds.has(i.sessionId));

  const subsessionCount = node.children.length;
  const workingCount = nodeInteractions.filter(
    (i) => i.status === "busy",
  ).length;
  const attentionCount = nodeInteractions.reduce(
    (sum, i) => sum + i.pendingPermissions.length + i.pendingQuestions.length,
    0,
  );

  const todos = nodeInteractions.flatMap((i) => i.todos);
  const completed = todos.filter((t) => t.status === "completed").length;
  const total = todos.filter((t) => t.status !== "cancelled").length;

  return { subsessionCount, workingCount, attentionCount, completed, total };
}

function shouldAutoExpand(
  node: SessionNode,
  interactions: SessionInteractionState[],
): boolean {
  const allIds = collectAllSessionIds(node);
  return interactions.some(
    (i) =>
      allIds.has(i.sessionId) &&
      (i.pendingPermissions.length > 0 ||
        i.pendingQuestions.length > 0 ||
        i.status === "busy"),
  );
}

function SessionStatusIcon({
  status,
}: {
  status: SessionInteractionState["status"];
}) {
  if (status === "busy") {
    return <Loader2 className="h-4 w-4 text-blue-500 shrink-0 animate-spin" />;
  }
  if (status === "idle") {
    return <Clock className="h-4 w-4 text-amber-500 shrink-0" />;
  }
  return <CheckCircle className="h-4 w-4 text-green-500 shrink-0" />;
}

const ChildSessionRow = memo(function ChildSessionRow({
  node,
  interactions,
  opencodeUrl,
  directory,
}: {
  node: SessionNode;
  interactions: SessionInteractionState[];
  opencodeUrl: string | undefined;
  directory: string;
}) {
  const session = node.session;
  const interaction = interactions.find((i) => i.sessionId === session.id);
  const status = interaction?.status ?? "unknown";
  const displayName = session.title || session.id.slice(0, 8);
  const todos = interaction?.todos ?? [];
  const currentTodo = todos.find((t) => t.status === "in_progress");

  const sessionUrl =
    opencodeUrl && directory
      ? buildOpenCodeSessionUrl(opencodeUrl, directory, session.id)
      : undefined;

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-sm py-1.5 px-3 rounded-md hover:bg-muted/50 transition-colors">
        <SessionStatusIcon status={status} />

        <span
          className="text-xs font-medium truncate shrink-0 max-w-[200px]"
          title={displayName}
        >
          {displayName}
        </span>

        {currentTodo && (
          <span className="truncate text-xs text-muted-foreground flex-1">
            {currentTodo.content}
          </span>
        )}
        {!currentTodo && <span className="flex-1" />}

        {interaction && (status === "busy" || status === "idle") && (
          <SessionStatusIndicator
            interaction={{
              status: interaction.status,
              pendingPermissions: interaction.pendingPermissions,
              pendingQuestions: interaction.pendingQuestions,
            }}
            compact
          />
        )}

        {sessionUrl && (
          <a
            href={sessionUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
      </div>

      {todos.length > 0 && (
        <div className="ml-9">
          <ExpandableTodoList todos={todos} sessionId={session.id} />
        </div>
      )}

      {node.children.length > 0 && (
        <div className="ml-4 space-y-1">
          {node.children.map((child) => (
            <ChildSessionRow
              key={child.session.id}
              node={child}
              interactions={interactions}
              opencodeUrl={opencodeUrl}
              directory={directory}
            />
          ))}
        </div>
      )}
    </div>
  );
});

const RootSessionAccordion = memo(function RootSessionAccordion({
  node,
  interactions,
  opencodeUrl,
  directory,
  sessionLabel,
}: {
  node: SessionNode;
  interactions: SessionInteractionState[];
  opencodeUrl: string | undefined;
  directory: string;
  sessionLabel?: string;
}) {
  const session = node.session;
  const interaction = interactions.find((i) => i.sessionId === session.id);
  const status = interaction?.status ?? "unknown";
  const todos = interaction?.todos ?? [];

  const autoExpand = useMemo(
    () => shouldAutoExpand(node, interactions),
    [node, interactions],
  );

  const summary = useMemo(
    () => computeNodeSummary(node, interactions),
    [node, interactions],
  );

  const sessionUrl =
    opencodeUrl && directory
      ? buildOpenCodeSessionUrl(opencodeUrl, directory, session.id)
      : undefined;

  const displayName =
    sessionLabel ??
    session.title ??
    (session.id ? `Session ${session.id.slice(0, 8)}` : "Session");

  const hasChildren = node.children.length > 0;

  return (
    <Collapsible defaultOpen={autoExpand} className="group/root">
      <div className="rounded-lg border bg-card text-card-foreground shadow-sm overflow-hidden">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className={cn(
              "flex w-full items-center gap-2.5 px-4 py-3 text-sm transition-colors",
              "hover:bg-muted/50 cursor-pointer text-left",
            )}
          >
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/root:rotate-90" />

            <SessionStatusIcon status={status} />

            <span className="font-medium truncate flex-1">{displayName}</span>

            {/* biome-ignore lint/a11y/useSemanticElements: badge container needs event isolation */}
            <span
              className="flex items-center gap-1.5 shrink-0"
              onClick={(e: React.MouseEvent) => e.stopPropagation()}
              onKeyDown={(e: React.KeyboardEvent) => e.stopPropagation()}
              role="group"
            >
              {summary.subsessionCount > 0 && (
                <Badge
                  variant="secondary"
                  className="text-xs px-1.5 py-0 h-5 font-normal"
                >
                  {summary.subsessionCount} sub
                </Badge>
              )}

              {summary.workingCount > 0 && (
                <Badge
                  variant="secondary"
                  className="text-xs px-1.5 py-0 h-5 font-normal bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                >
                  {summary.workingCount} working
                </Badge>
              )}

              {summary.attentionCount > 0 && (
                <Badge
                  variant="secondary"
                  className="text-xs px-1.5 py-0 h-5 font-normal bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300 gap-0.5"
                >
                  <AlertTriangle className="h-3 w-3" />
                  {summary.attentionCount}
                </Badge>
              )}

              {summary.total > 0 && (
                <Badge
                  variant="outline"
                  className="text-xs px-1.5 py-0 h-5 font-normal gap-0.5"
                >
                  <CheckCircle className="h-3 w-3" />
                  {summary.completed}/{summary.total}
                </Badge>
              )}

              {sessionUrl && (
                <a
                  href={sessionUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted-foreground hover:text-foreground transition-colors p-0.5"
                  onClick={(e) => e.stopPropagation()}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
            </span>
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="border-t px-4 py-2 space-y-2">
            {todos.length > 0 && (
              <ExpandableTodoList
                todos={todos}
                sessionId={session.id}
                defaultExpanded
              />
            )}

            {hasChildren && (
              <div className="space-y-1">
                {node.children.map((child) => (
                  <ChildSessionRow
                    key={child.session.id}
                    node={child}
                    interactions={interactions}
                    opencodeUrl={opencodeUrl}
                    directory={directory}
                  />
                ))}
              </div>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
});

export type SessionHierarchyProps = {
  hierarchy: SessionNode[];
  interactions: SessionInteractionState[];
  opencodeUrl: string | undefined;
  directory: string;
  filterFn?: (node: SessionNode) => boolean;
  labelFn?: (node: SessionNode) => string | undefined;
};

export function SessionHierarchy({
  hierarchy,
  interactions,
  opencodeUrl,
  directory,
  filterFn,
  labelFn,
}: SessionHierarchyProps) {
  const filteredHierarchy = filterFn ? hierarchy.filter(filterFn) : hierarchy;

  if (filteredHierarchy.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2">
      {filteredHierarchy.map((node) => (
        <RootSessionAccordion
          key={node.session.id}
          node={node}
          interactions={interactions}
          opencodeUrl={opencodeUrl}
          directory={directory}
          sessionLabel={labelFn?.(node)}
        />
      ))}
    </div>
  );
}
