import type { SessionWithSandbox } from "@/hooks/use-all-sessions";

export type SessionNode<T extends { id: string; parentID?: string | null }> = {
  session: T;
  children: SessionNode<T>[];
};

export function buildSessionHierarchy<
  T extends {
    id: string;
    parentID?: string | null;
    time: { updated?: number; created?: number };
  },
>(sessions: T[]): SessionNode<T>[] {
  const sessionMap = new Map<string, SessionNode<T>>();
  for (const session of sessions) {
    sessionMap.set(session.id, { session, children: [] });
  }

  const rootNodes: SessionNode<T>[] = [];

  for (const session of sessions) {
    const node = sessionMap.get(session.id);
    if (!node) continue;

    if (session.parentID) {
      const parentNode = sessionMap.get(session.parentID);
      if (parentNode) {
        parentNode.children.push(node);
      } else {
        rootNodes.push(node);
      }
    } else {
      rootNodes.push(node);
    }
  }

  const sortByTime = (nodes: SessionNode<T>[]) => {
    nodes.sort((a, b) => {
      const aTime = a.session.time.updated || a.session.time.created;
      const bTime = b.session.time.updated || b.session.time.created;
      if (!aTime || !bTime) return 0;
      return bTime - aTime;
    });
    for (const node of nodes) {
      if (node.children.length > 0) {
        sortByTime(node.children);
      }
    }
  };

  sortByTime(rootNodes);

  return rootNodes;
}

export function countSubSessions<T extends { id: string }>(
  node: SessionNode<T>,
): number {
  let count = node.children.length;
  for (const child of node.children) {
    count += countSubSessions(child);
  }
  return count;
}

export type SessionWithSandboxNode = SessionNode<SessionWithSandbox>;
