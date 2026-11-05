import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { InboxTask } from "@/api/queries/tasks";
import {
  finishedSince,
  loadNotifyEnabled,
  saveNotifyEnabled,
} from "@/lib/task-inbox";

let enabled: boolean | undefined;
const listeners = new Set<() => void>();

function current(): boolean {
  enabled ??= loadNotifyEnabled();
  return enabled;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const supported = () => typeof Notification !== "undefined";

/** The opt-in toggle: browser notifications for finished tasks. Turning it on
 * asks for the permission (on the click that calls `toggle`). */
export function useTaskNotificationSetting() {
  const on = useSyncExternalStore(subscribe, current);
  const granted = supported() && Notification.permission === "granted";

  async function toggle() {
    if (!supported()) return;
    let next = !current();
    if (next && Notification.permission !== "granted") {
      next = (await Notification.requestPermission()) === "granted";
    }
    enabled = next;
    saveNotifyEnabled(next);
    for (const listener of listeners) listener();
  }

  return {
    supported: supported(),
    denied: supported() && Notification.permission === "denied",
    active: on && granted,
    toggle,
  };
}

/**
 * While the tab is hidden, one notification per task that moved from running
 * to finished/failed between two polls. Clicking it focuses the tab and opens
 * the task's sandbox. No service worker: it only works while the tab lives.
 */
export function useTaskNotifications(tasks: readonly InboxTask[] | undefined) {
  const navigate = useNavigate();
  const { active } = useTaskNotificationSetting();
  const previous = useRef<readonly InboxTask[] | undefined>(undefined);

  useEffect(() => {
    if (!tasks) return;
    const before = previous.current;
    previous.current = tasks;
    if (!before || !active || !document.hidden) return;
    for (const task of finishedSince(before, tasks)) {
      const notification = new Notification(
        task.status === "failed" ? "Task failed" : "Task ready for review",
        {
          body: `${task.title} · ${task.sandboxName ?? task.sandboxId}`,
          tag: task.taskId,
        },
      );
      notification.onclick = () => {
        window.focus();
        notification.close();
        navigate({
          to: "/sandboxes/$sandboxId/sessions",
          params: { sandboxId: task.sandboxId },
        });
      };
    }
  }, [tasks, active, navigate]);
}
