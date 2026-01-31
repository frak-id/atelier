import {
  AlertTriangle,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Clock,
  ExternalLink,
  Loader2,
} from "lucide-react";
import { useMemo, useState } from "react";
import { ExpandableTodoList } from "@/components/expandable-todo-list";
import { SessionStatusIndicator } from "@/components/session-status-indicator";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { SessionInteractionState } from "@/hooks/use-task-session-progress";
import { countSubSessions, type SessionNode } from "@/lib/session-hierarchy";
import { buildOpenCodeSessionUrl } from "@/lib/utils";

function computeNodeSummary(
  node: SessionNode,
  interactions: SessionInteractionState[],
) {
  const allIds = collectAllSessionIds(node);
  let working = 0;
  let attention = 0;
  let completedTodos = 0;
  let totalTodos = 0;

  for (const id of allIds) {
    const interaction = interactions.find((i) => i.sessionId === id);
    if (!interaction) continue;
    if (interaction.status === "busy") working++;
    if (
      interaction.pendingPermissions.length > 0 ||
      interaction.pendingQuestions.length > 0
    )
      attention++;
    for (const todo of interaction.todos) {
      if (todo.status === "cancelled") continue;
      totalTodos++;
      if (todo.status === "completed") completedTodos++;
    }
  }

  return {
    subSessions: countSubSessions(node),
    working,
    attention,
    completedTodos,
    totalTodos,
  };
}

function collectAllSessionIds(node: SessionNode): string[] {
  const ids = [node.session.id];
  for (const child of node.children) {
    ids.push(...collectAllSessionIds(child));
  }
  return ids;
}

function shouldAutoExpand(
  node: SessionNode,
  interactions: SessionInteractionState[],
): boolean {
  const allIds = collectAllSessionIds(node);
  for (const id of allIds) {
    const interaction = interactions.find((i) => i.sessionId === id);
    if (!interaction) continue;
    if (interaction.status === "busy") return true;
    if (
      interaction.pendingPermissions.length > 0 ||
      interaction.pendingQuestions.length > 0
    )
      return true;
  }
  return false;
}

type ChildSessionRowProps = {
  node: SessionNode;
  depth: number;
  interactions: SessionInteractionState[];
  opencodeUrl: string | undefined;
  directory: string;
};

function ChildSessionRow({
  node,
  depth,
  interactions,
  opencodeUrl,
  directory,
}: ChildSessionRowProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const session = node.session;
  const hasChildren = node.children.length > 0;
  const interaction = interactions.find((i) => i.sessionId === session.id);

  const shortId = session.id.slice(0, 8);
  const realStatus = interaction?.status ?? "unknown";
  const todos = interaction?.todos ?? [];

  const needsAttention =
    interaction &&
    (interaction.pendingPermissions.length > 0 ||
      interaction.pendingQuestions.length > 0);

  const sessionUrl =
    opencodeUrl && directory
      ? buildOpenCodeSessionUrl(opencodeUrl, directory, session.id)
      : undefined;

  const currentTodo = todos.find((t) => t.status === "in_progress");

  return (
    <div>
      <div
        className="flex items-center gap-2 text-sm py-1.5 px-2 rounded-md hover:bg-muted/60 transition-colors"
        style={{ marginLeft: depth * 20 }}
      >
        {hasChildren ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-5 w-5 p-0 shrink-0"
            onClick={() => setIsExpanded(!isExpanded)}
          >
            {isExpanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </Button>
        ) : (
          <div className="w-5 shrink-0" />
        )}

        {realStatus === "busy" ? (
          <Loader2 className="h-3.5 w-3.5 text-blue-500 shrink-0 animate-spin" />
        ) : realStatus === "idle" ? (
          <Clock className="h-3.5 w-3.5 text-amber-500 shrink-0" />
        ) : (
          <CheckCircle className="h-3.5 w-3.5 text-green-500 shrink-0" />
        )}

        <span className="font-mono text-xs text-muted-foreground shrink-0">
          {shortId}
        </span>

        {currentTodo && (
          <span className="text-xs text-muted-foreground truncate flex-1">
            {currentTodo.content}
          </span>
        )}
        {!currentTodo && <span className="flex-1" />}

        {interaction && (realStatus === "busy" || realStatus === "idle") && (
          <SessionStatusIndicator
            interaction={{
              status: interaction.status,
              pendingPermissions: interaction.pendingPermissions,
              pendingQuestions: interaction.pendingQuestions,
            }}
            compact
          />
        )}

        {needsAttention && sessionUrl && (
          <Button
            variant="outline"
            size="sm"
            className="h-6 text-xs px-2 gap-1"
            asChild
          >
            <a href={sessionUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-3 w-3" />
              Respond
            </a>
          </Button>
        )}

        {!needsAttention && sessionUrl && (
          <Button variant="ghost" size="sm" className="h-6 w-6 p-0" asChild>
            <a href={sessionUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-3 w-3" />
            </a>
          </Button>
        )}
      </div>

      {todos.length > 0 && (
        <div className="mt-0.5" style={{ marginLeft: depth * 20 + 24 }}>
          <ExpandableTodoList todos={todos} sessionId={session.id} />
        </div>
      )}

      {hasChildren && isExpanded && (
        <div className="mt-0.5 space-y-0.5">
          {node.children.map((child) => (
            <ChildSessionRow
              key={child.session.id}
              node={child}
              depth={depth + 1}
              interactions={interactions}
              opencodeUrl={opencodeUrl}
              directory={directory}
            />
          ))}
        </div>
      )}
    </div>
  );
}

type RootSessionAccordionProps = {
  node: SessionNode;
  interactions: SessionInteractionState[];
  opencodeUrl: string | undefined;
  directory: string;
  sessionLabel?: string;
};

function RootSessionAccordion({
  node,
  interactions,
  opencodeUrl,
  directory,
  sessionLabel,
}: RootSessionAccordionProps) {
  const session = node.session;
  const interaction = interactions.find((i) => i.sessionId === session.id);
  const realStatus = interaction?.status ?? "unknown";
  const todos = interaction?.todos ?? [];

  const autoExpand = shouldAutoExpand(node, interactions);
  const [isOpen, setIsOpen] = useState(autoExpand);

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

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <div className="rounded-lg border bg-card text-card-foreground shadow-sm overflow-hidden">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-2.5 px-3 py-2.5 hover:bg-muted/40 transition-colors text-left"
          >
            {isOpen ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
            )}

            {realStatus === "busy" ? (
              <Loader2 className="h-4 w-4 text-blue-500 shrink-0 animate-spin" />
            ) : realStatus === "idle" ? (
              <Clock className="h-4 w-4 text-amber-500 shrink-0" />
            ) : (
              <CheckCircle className="h-4 w-4 text-green-500 shrink-0" />
            )}

            <span className="text-sm font-medium truncate flex-1">
              {displayName}
            </span>

            <div className="flex items-center gap-1.5 shrink-0">
              {summary.subSessions > 0 && (
                <Badge
                  variant="secondary"
                  className="text-[10px] px-1.5 py-0 h-5"
                >
                  {summary.subSessions} sub
                </Badge>
              )}

              {summary.working > 0 && (
                <Badge
                  variant="secondary"
                  className="text-[10px] px-1.5 py-0 h-5 bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-300"
                >
                  {summary.working} working
                </Badge>
              )}

              {summary.attention > 0 && (
                <Badge
                  variant="secondary"
                  className="text-[10px] px-1.5 py-0 h-5 bg-amber-100 dark:bg-amber-950 text-amber-700 dark:text-amber-300"
                >
                  <AlertTriangle className="h-3 w-3 mr-0.5" />
                  {summary.attention}
                </Badge>
              )}

              {summary.totalTodos > 0 && (
                <Badge
                  variant="outline"
                  className="text-[10px] px-1.5 py-0 h-5"
                >
                  {summary.completedTodos}/{summary.totalTodos}
                </Badge>
              )}
            </div>

            {sessionUrl && (
              <a
                href={sessionUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                onClick={(e) => e.stopPropagation()}
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="border-t px-2 py-2 space-y-1">
            {todos.length > 0 && (
              <div className="px-1 pb-1">
                <ExpandableTodoList todos={todos} sessionId={session.id} />
              </div>
            )}

            {node.children.map((child) => (
              <ChildSessionRow
                key={child.session.id}
                node={child}
                depth={0}
                interactions={interactions}
                opencodeUrl={opencodeUrl}
                directory={directory}
              />
            ))}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

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
