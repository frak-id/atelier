import type { Todo } from "@opencode-ai/sdk/v2";
import {
  AlertTriangle,
  CheckCircle,
  ChevronRight,
  Circle,
  Clock,
  ExternalLink,
  Loader2,
  MessageCircleQuestion,
  Shield,
  XCircle,
} from "lucide-react";
import { memo, useMemo } from "react";
import { SessionStatusIndicator } from "@/components/session-status-indicator";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { SessionInteractionState } from "@/hooks/use-task-session-progress";
import { getQuestionDisplayText } from "@/lib/intervention-helpers";
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

function TodoStatusIcon({ status }: { status: Todo["status"] }) {
  switch (status) {
    case "completed":
      return <CheckCircle className="h-3.5 w-3.5 text-green-500 shrink-0" />;
    case "in_progress":
      return (
        <Loader2 className="h-3.5 w-3.5 text-blue-500 shrink-0 animate-spin" />
      );
    case "cancelled":
      return <XCircle className="h-3.5 w-3.5 text-muted-foreground shrink-0" />;
    default:
      return <Circle className="h-3.5 w-3.5 text-muted-foreground shrink-0" />;
  }
}

function TodoProgressBadge({ todos }: { todos: Todo[] }) {
  const activeTodos = todos.filter((t) => t.status !== "cancelled");
  const completed = activeTodos.filter((t) => t.status === "completed").length;
  const total = activeTodos.length;

  if (total === 0) return null;

  const allDone = completed === total;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "text-xs px-1.5 h-5 rounded-md border font-mono shrink-0 tabular-nums",
            "hover:bg-muted transition-colors",
            allDone
              ? "text-green-500 border-green-500/30"
              : "text-muted-foreground border-border",
          )}
          onClick={(e) => e.stopPropagation()}
        >
          {completed}/{total}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0" collisionPadding={8}>
        <div className="px-3 py-2 border-b text-xs font-medium text-muted-foreground">
          Tasks — {completed}/{total} completed
        </div>
        <ul className="max-h-60 overflow-y-auto py-1">
          {activeTodos.map((todo) => (
            <li
              key={todo.id || todo.content.slice(0, 50)}
              className="flex items-start gap-2 px-3 py-1.5 text-xs"
            >
              <div className="mt-px shrink-0">
                <TodoStatusIcon status={todo.status} />
              </div>
              <span
                className={cn(
                  "leading-tight",
                  todo.status === "completed" &&
                    "text-muted-foreground line-through",
                )}
              >
                {todo.content}
              </span>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function RootTodoList({ todos }: { todos: Todo[] }) {
  const activeTodos = todos.filter((t) => t.status !== "cancelled");
  if (activeTodos.length === 0) return null;

  const completed = activeTodos.filter((t) => t.status === "completed").length;
  const currentTodo = activeTodos.find((t) => t.status === "in_progress");

  return (
    <Collapsible className="group/todos">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted/50 rounded transition-colors"
        >
          <ChevronRight className="h-3 w-3 shrink-0 transition-transform group-data-[state=open]/todos:rotate-90" />
          <span className="font-medium">
            Tasks ({completed}/{activeTodos.length})
          </span>
          {currentTodo && (
            <span className="truncate italic text-muted-foreground/70 flex-1 text-left">
              — {currentTodo.content}
            </span>
          )}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="py-1 ml-5">
          {activeTodos.map((todo) => (
            <li
              key={todo.id || todo.content.slice(0, 50)}
              className="flex items-start gap-2 px-3 py-1 text-xs"
            >
              <div className="mt-px shrink-0">
                <TodoStatusIcon status={todo.status} />
              </div>
              <span
                className={cn(
                  "leading-tight",
                  todo.status === "completed" &&
                    "text-muted-foreground line-through",
                )}
              >
                {todo.content}
              </span>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

function PendingInterventionLines({
  interaction,
}: {
  interaction: SessionInteractionState | undefined;
}) {
  if (!interaction) return null;
  const { pendingPermissions, pendingQuestions } = interaction;
  if (pendingPermissions.length === 0 && pendingQuestions.length === 0)
    return null;

  return (
    <div className="ml-9 space-y-0.5 py-0.5">
      {pendingPermissions.map((p) => (
        <div
          key={p.id}
          className="flex items-center gap-1.5 text-xs text-purple-400"
        >
          <Shield className="h-3 w-3 shrink-0" />
          <span className="truncate">{p.permission}</span>
        </div>
      ))}
      {pendingQuestions.map((q) => (
        <div key={q.id} className="space-y-0.5">
          <div className="flex items-center gap-1.5 text-xs text-cyan-400">
            <MessageCircleQuestion className="h-3 w-3 shrink-0" />
            <span className="truncate">{getQuestionDisplayText(q)}</span>
          </div>
          {q.questions.length > 1 && (
            <div className="ml-4.5 space-y-px">
              {q.questions.map((qi) => (
                <div
                  key={qi.header}
                  className="text-xs text-cyan-400/60 truncate"
                >
                  • {qi.question}
                </div>
              ))}
            </div>
          )}
          {q.questions.length === 1 && (
            <div className="ml-4.5 text-xs text-cyan-400/60 truncate">
              {q.questions[0]?.question}
            </div>
          )}
        </div>
      ))}
    </div>
  );
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
    <div>
      <div className="flex items-center gap-2 text-sm py-1.5 px-3 rounded-md hover:bg-muted/50 transition-colors">
        <SessionStatusIcon status={status} />

        <span
          className="text-xs font-medium truncate min-w-0"
          title={displayName}
        >
          {displayName}
        </span>

        {currentTodo && (
          <span className="truncate text-xs text-muted-foreground italic flex-1 min-w-0">
            {currentTodo.content}
          </span>
        )}
        {!currentTodo && <span className="flex-1" />}

        <TodoProgressBadge todos={todos} />

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

      <PendingInterventionLines interaction={interaction} />

      {node.children.length > 0 && (
        <div className="ml-6 border-l border-border/50 space-y-0.5 mt-0.5">
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

            <span className="font-medium truncate flex-1 min-w-0">
              {displayName}
            </span>

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
                  className="text-xs px-1.5 py-0 h-5 font-normal hidden sm:inline-flex"
                >
                  {summary.subsessionCount} sub
                </Badge>
              )}

              {summary.workingCount > 0 && (
                <Badge
                  variant="secondary"
                  className="text-xs px-1.5 py-0 h-5 font-normal bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300 hidden sm:inline-flex"
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
          <div className="border-t px-2 py-2 space-y-1">
            <PendingInterventionLines interaction={interaction} />

            {todos.length > 0 && <RootTodoList todos={todos} />}

            {hasChildren && (
              <div className="space-y-0.5">
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
