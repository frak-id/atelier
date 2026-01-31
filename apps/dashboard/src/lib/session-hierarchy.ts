import type { Session } from "@opencode-ai/sdk/v2";

export type SessionWithSandboxInfo = Session & {
  sandbox: {
    id: string;
    workspaceId: string | undefined;
    opencodeUrl: string;
  };
};

export type SessionNode = {
  session: SessionWithSandboxInfo;
  children: SessionNode[];
};

export function buildSessionHierarchy(
  sessions: SessionWithSandboxInfo[],
): SessionNode[] {
  const sessionMap = new Map<string, SessionNode>();

  for (const session of sessions) {
    sessionMap.set(session.id, { session, children: [] });
  }

  const rootNodes: SessionNode[] = [];

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

  const sortByTime = (nodes: SessionNode[]) => {
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

export function countSubSessions(node: SessionNode): number {
  let count = node.children.length;
  for (const child of node.children) {
    count += countSubSessions(child);
  }
  return count;
}

export function flattenHierarchy(
  nodes: SessionNode[],
): SessionWithSandboxInfo[] {
  const result: SessionWithSandboxInfo[] = [];
  for (const node of nodes) {
    result.push(node.session);
    if (node.children.length > 0) {
      result.push(...flattenHierarchy(node.children));
    }
  }
  return result;
}
