import type { Task } from "@frak/atelier-manager/types";
import { SessionHierarchy } from "@/components/session-hierarchy";
import type { SessionInteractionState } from "@/hooks/use-task-session-progress";
import type { SessionNode } from "@/lib/session-hierarchy";

type TaskSession = NonNullable<Task["data"]["sessions"]>[number];

type TaskSessionHierarchyProps = {
  hierarchy: SessionNode[];
  taskSessions: TaskSession[];
  interactions: SessionInteractionState[];
  agentUrl: string | undefined;
  directory: string;
};

export function TaskSessionHierarchy({
  hierarchy,
  taskSessions,
  interactions,
  agentUrl,
  directory,
}: TaskSessionHierarchyProps) {
  return (
    <SessionHierarchy
      hierarchy={hierarchy}
      interactions={interactions}
      agentUrl={agentUrl}
      directory={directory}
      labelFn={(node) => {
        const taskSession = taskSessions.find(
          (ts) => ts.id === node.session.id,
        );
        const templateId = taskSession?.templateId;
        const title = node.session.title;
        if (title && templateId) return `${title} - ${templateId}`;
        return templateId ?? title ?? undefined;
      }}
    />
  );
}
