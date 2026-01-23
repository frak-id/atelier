import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import {
  sandboxListQuery,
  taskListQuery,
  workspaceListQuery,
} from "@/api/queries";
import type { AttentionItem } from "@/components/dashboard/attention-list";
import type { RunningSession } from "@/components/dashboard/running-sessions";
import { useAllSessions } from "./use-all-sessions";

export function useAttentionTasks() {
  const { data: tasks } = useQuery(taskListQuery());
  const { data: workspaces } = useQuery(workspaceListQuery());
  const { data: sandboxes } = useQuery(sandboxListQuery());

  const workspaceMap = useMemo(() => {
    const map = new Map<string, string>();
    if (workspaces) {
      for (const w of workspaces) {
        map.set(w.id, w.name);
      }
    }
    return map;
  }, [workspaces]);

  const sandboxMap = useMemo(() => {
    const map = new Map<
      string,
      {
        vscodeUrl: string;
        opencodeUrl: string;
        sshCommand: string;
        workspaceId?: string;
      }
    >();
    if (sandboxes) {
      for (const s of sandboxes) {
        if (s.status === "running") {
          map.set(s.id, {
            vscodeUrl: s.runtime.urls.vscode,
            opencodeUrl: s.runtime.urls.opencode,
            sshCommand: `ssh dev@${s.runtime.ipAddress}`,
            workspaceId: s.workspaceId ?? undefined,
          });
        }
      }
    }
    return map;
  }, [sandboxes]);

  const attentionTasks = useMemo(() => {
    if (!tasks) return [];
    return tasks.filter((t) => t.status === "pending_review");
  }, [tasks]);

  const attentionItems = useMemo(() => {
    const items: AttentionItem[] = [];

    for (const task of attentionTasks) {
      const sandboxId = task.data.sandboxId;
      const sandbox = sandboxId ? sandboxMap.get(sandboxId) : undefined;
      const workspaceName = task.workspaceId
        ? workspaceMap.get(task.workspaceId)
        : undefined;

      items.push({
        id: task.id,
        title: task.title,
        workspaceName,
        lastMessage: task.data.description,
        updatedAt: task.updatedAt,
        vscodeUrl: sandbox?.vscodeUrl,
        opencodeUrl: sandbox?.opencodeUrl,
        type: "task",
      });
    }

    items.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );

    return items;
  }, [attentionTasks, workspaceMap, sandboxMap]);

  return {
    items: attentionItems,
    taskCount: attentionTasks.length,
    sessionCount: 0,
    totalCount: attentionItems.length,
  };
}

export function useStatusCounts() {
  const { data: tasks } = useQuery(taskListQuery());
  const { totalCount: attentionCount } = useAttentionTasks();

  return useMemo(() => {
    const counts = {
      draft: 0,
      queued: 0,
      in_progress: 0,
      pending_review: 0,
      completed: 0,
      attention: attentionCount,
    };

    if (!tasks) return counts;

    for (const task of tasks) {
      switch (task.status) {
        case "draft":
          counts.draft++;
          break;
        case "queue":
          counts.queued++;
          break;
        case "in_progress":
          counts.in_progress++;
          break;
        case "pending_review":
          counts.pending_review++;
          break;
        case "completed":
          counts.completed++;
          break;
      }
    }

    return counts;
  }, [tasks, attentionCount]);
}

export function useRunningSessions(): RunningSession[] {
  const { sessions } = useAllSessions();
  const { data: workspaces } = useQuery(workspaceListQuery());
  const { data: sandboxes } = useQuery(sandboxListQuery());

  const workspaceMap = useMemo(() => {
    const map = new Map<string, string>();
    if (workspaces) {
      for (const w of workspaces) {
        map.set(w.id, w.name);
      }
    }
    return map;
  }, [workspaces]);

  const sandboxMap = useMemo(() => {
    const map = new Map<
      string,
      {
        vscodeUrl: string;
        opencodeUrl: string;
        sshCommand: string;
      }
    >();
    if (sandboxes) {
      for (const s of sandboxes) {
        if (s.status === "running") {
          map.set(s.id, {
            vscodeUrl: s.runtime.urls.vscode,
            opencodeUrl: s.runtime.urls.opencode,
            sshCommand: `ssh dev@${s.runtime.ipAddress}`,
          });
        }
      }
    }
    return map;
  }, [sandboxes]);

  return useMemo(() => {
    return sessions.map((session) => {
      const workspaceName = session.sandbox.workspaceId
        ? workspaceMap.get(session.sandbox.workspaceId)
        : undefined;
      const sandbox = sandboxMap.get(session.sandbox.id);

      const updatedAt = session.time.updated || session.time.created;
      return {
        id: session.id,
        title: session.title || `Session ${session.id.slice(0, 8)}`,
        workspaceName,
        progress: undefined,
        status: "idle" as const,
        updatedAt:
          typeof updatedAt === "string" ? updatedAt : new Date().toISOString(),
        vscodeUrl: sandbox?.vscodeUrl,
        sshCommand: sandbox?.sshCommand,
        opencodeUrl: session.sandbox.opencodeUrl,
      };
    });
  }, [sessions, workspaceMap, sandboxMap]);
}
