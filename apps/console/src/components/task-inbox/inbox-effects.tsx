import { useEffect } from "react";
import { useTaskInbox } from "@/hooks/use-task-inbox";
import { useTaskNotifications } from "@/hooks/use-task-notifications";

const BASE_TITLE = document.title;

/** Mounted once for a signed-in user: the tab title carries the number of
 * tasks waiting on the user, and finished tasks notify while the tab is
 * hidden. Renders nothing. */
export function TaskInboxEffects() {
  const { tasks, attention } = useTaskInbox();
  useTaskNotifications(tasks);

  useEffect(() => {
    document.title =
      attention > 0 ? `(${attention}) ${BASE_TITLE}` : BASE_TITLE;
    return () => {
      document.title = BASE_TITLE;
    };
  }, [attention]);

  return null;
}
