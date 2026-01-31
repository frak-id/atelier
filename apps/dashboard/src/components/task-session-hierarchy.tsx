import type { Task } from "@frak-sandbox/manager/types";
import { SessionHierarchy } from "@/components/session-hierarchy";
import type { SessionInteractionState } from "@/hooks/use-task-session-progress";
import type { SessionNode } from "@/lib/session-hierarchy";

type TaskSessionHierarchyProps = {
  hierarchy: SessionNode[];
  taskSessions: NonNullable<Task["data"]["sessions"]>;
  interactions: SessionInteractionState[];
  opencodeUrl: string | undefined;
  directory: string;
};

export function TaskSessionHierarchy({
  hierarchy,
  taskSessions: _taskSessions,
  interactions,
  opencodeUrl,
  directory,
}: TaskSessionHierarchyProps) {
  return (
    <SessionHierarchy
      hierarchy={hierarchy}
      interactions={interactions}
      opencodeUrl={opencodeUrl}
      directory={directory}
    />
  );
}
