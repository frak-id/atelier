import type { Task } from "@frak-sandbox/manager/types";
import {
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Clock,
  ExternalLink,
  Loader2,
} from "lucide-react";
import { useState } from "react";
import { ExpandableTodoList } from "@/components/expandable-todo-list";
import { SessionStatusIndicator } from "@/components/session-status-indicator";
import { Button } from "@/components/ui/button";
import type { SessionInteractionState } from "@/hooks/use-task-session-progress";
import { countSubSessions, type SessionNode } from "@/lib/session-hierarchy";
import { buildOpenCodeSessionUrl } from "@/lib/utils";

type TaskSession = NonNullable<Task["data"]["sessions"]>[number];

type TaskSessionNodeProps = {
  node: SessionNode;
  depth: number;
  taskSessions: TaskSession[];
  interactions: SessionInteractionState[];
  opencodeUrl: string | undefined;
  directory: string;
};

function TaskSessionNode({
  node,
  depth,
  taskSessions,
  interactions,
  opencodeUrl,
  directory,
}: TaskSessionNodeProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const session = node.session;
  const hasChildren = node.children.length > 0;
  const totalSubSessions = hasChildren ? countSubSessions(node) : 0;

  const taskSession = taskSessions.find((ts) => ts.id === session.id);
  const interaction = interactions.find((i) => i.sessionId === session.id);

  const shortId = session.id.slice(0, 8);
  const templateId = taskSession?.templateId;
  const startedAt = taskSession?.startedAt;
  const realStatus = interaction?.status ?? "unknown";

  const needsAttention =
    interaction &&
    (interaction.pendingPermissions.length > 0 ||
      interaction.pendingQuestions.length > 0);

  const todos = interaction?.todos ?? [];

  const sessionUrl =
    opencodeUrl && directory
      ? buildOpenCodeSessionUrl(opencodeUrl, directory, session.id)
      : undefined;

  return (
    <div>
      <div
        className="flex items-center gap-2 text-sm py-2 px-3 bg-muted/50 rounded-lg hover:bg-muted transition-colors"
        style={{ marginLeft: depth * 24 }}
      >
        {hasChildren ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 shrink-0"
            onClick={() => setIsExpanded(!isExpanded)}
          >
            {isExpanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </Button>
        ) : (
          <div className="w-6 shrink-0" />
        )}

        {realStatus === "busy" ? (
          <Loader2 className="h-4 w-4 text-blue-500 shrink-0 animate-spin" />
        ) : realStatus === "idle" ? (
          <Clock className="h-4 w-4 text-amber-500 shrink-0" />
        ) : (
          <CheckCircle className="h-4 w-4 text-green-500 shrink-0" />
        )}

        <span className="truncate flex-1">
          {session.title && (
            <>
              {session.title}
              {templateId && " - "}
            </>
          )}
          {templateId && templateId}
          {!session.title && !templateId && "Session"}{" "}
          <span className="font-mono text-muted-foreground">({shortId})</span>
        </span>

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
            className="h-7 text-xs px-2 gap-1"
            asChild
          >
            <a href={sessionUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-3 w-3" />
              Respond
            </a>
          </Button>
        )}

        {!needsAttention && sessionUrl && (
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" asChild>
            <a href={sessionUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </Button>
        )}

        {hasChildren && !isExpanded && (
          <button
            type="button"
            onClick={() => setIsExpanded(true)}
            className="text-xs text-muted-foreground hover:text-foreground cursor-pointer shrink-0"
          >
            {totalSubSessions} sub-session{totalSubSessions !== 1 ? "s" : ""}
          </button>
        )}

        {startedAt && (
          <span className="text-muted-foreground text-xs shrink-0">
            {new Date(startedAt).toLocaleTimeString()}
          </span>
        )}
      </div>

      {todos.length > 0 && (
        <div className="mt-1" style={{ marginLeft: depth * 24 + 28 }}>
          <ExpandableTodoList todos={todos} sessionId={session.id} />
        </div>
      )}

      {hasChildren && isExpanded && (
        <div className="mt-1 space-y-1">
          {node.children.map((child) => (
            <TaskSessionNode
              key={child.session.id}
              node={child}
              depth={depth + 1}
              taskSessions={taskSessions}
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

type TaskSessionHierarchyProps = {
  hierarchy: SessionNode[];
  taskSessions: TaskSession[];
  interactions: SessionInteractionState[];
  opencodeUrl: string | undefined;
  directory: string;
};

export function TaskSessionHierarchy({
  hierarchy,
  taskSessions,
  interactions,
  opencodeUrl,
  directory,
}: TaskSessionHierarchyProps) {
  return (
    <div className="space-y-2">
      {hierarchy.map((node) => (
        <TaskSessionNode
          key={node.session.id}
          node={node}
          depth={0}
          taskSessions={taskSessions}
          interactions={interactions}
          opencodeUrl={opencodeUrl}
          directory={directory}
        />
      ))}
    </div>
  );
}
