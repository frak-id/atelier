import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import {
  SessionRow,
  type SessionWithSandboxInfo,
} from "@/components/session-row";
import { Button } from "@/components/ui/button";
import {
  buildSessionHierarchy,
  countSubSessions,
  type SessionNode,
} from "@/lib/session-hierarchy";

type SessionNodeItemProps = {
  node: SessionNode;
  depth: number;
  showSandboxInfo?: boolean;
  showDelete?: boolean;
  onDelete?: (sessionId: string) => void;
  isDeleting?: boolean;
};

function SessionNodeItem({
  node,
  depth,
  showSandboxInfo,
  showDelete,
  onDelete,
  isDeleting,
}: SessionNodeItemProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const hasChildren = node.children.length > 0;
  const totalSubSessions = hasChildren ? countSubSessions(node) : 0;

  return (
    <div>
      <div
        className="flex items-center gap-1"
        style={{ paddingLeft: depth * 16 }}
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
        <div className="flex-1 min-w-0">
          <SessionRow
            session={node.session}
            showSandboxInfo={showSandboxInfo}
            showDelete={showDelete}
            onDelete={onDelete}
            isDeleting={isDeleting}
          />
        </div>
      </div>
      {hasChildren && !isExpanded && (
        <button
          type="button"
          onClick={() => setIsExpanded(true)}
          className="text-xs text-muted-foreground hover:text-foreground ml-7 pl-4 cursor-pointer"
          style={{ paddingLeft: depth * 16 + 28 }}
        >
          {totalSubSessions} sub-session{totalSubSessions !== 1 ? "s" : ""}
        </button>
      )}
      {hasChildren && isExpanded && (
        <div>
          {node.children.map((child) => (
            <SessionNodeItem
              key={child.session.id}
              node={child}
              depth={depth + 1}
              showSandboxInfo={showSandboxInfo}
              showDelete={showDelete}
              onDelete={onDelete}
              isDeleting={isDeleting}
            />
          ))}
        </div>
      )}
    </div>
  );
}

type HierarchicalSessionListProps = {
  sessions: SessionWithSandboxInfo[];
  showSandboxInfo?: boolean;
  showDelete?: boolean;
  onDelete?: (sessionId: string) => void;
  isDeleting?: boolean;
  limit?: number;
};

export function HierarchicalSessionList({
  sessions,
  showSandboxInfo,
  showDelete,
  onDelete,
  isDeleting,
  limit,
}: HierarchicalSessionListProps) {
  const hierarchy = buildSessionHierarchy(sessions);
  const displayedNodes = limit ? hierarchy.slice(0, limit) : hierarchy;
  const remainingCount = limit ? hierarchy.length - limit : 0;

  return (
    <div className="space-y-1">
      {displayedNodes.map((node) => (
        <SessionNodeItem
          key={node.session.id}
          node={node}
          depth={0}
          showSandboxInfo={showSandboxInfo}
          showDelete={showDelete}
          onDelete={onDelete}
          isDeleting={isDeleting}
        />
      ))}
      {remainingCount > 0 && (
        <p className="text-xs text-muted-foreground text-center pt-2">
          +{remainingCount} more session{remainingCount !== 1 ? "s" : ""}
        </p>
      )}
    </div>
  );
}
