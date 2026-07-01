import type { AgentEvent } from "@frak/atelier-shared";
import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/api/queries";

const RECONNECT_DELAY_MS = 5000;

interface Subscription {
  source: EventSource | null;
  timer: ReturnType<typeof setTimeout> | null;
}

const connections = new Map<string, Subscription>();
/** The set of sandboxes we currently WANT streamed. A reconnect only fires if
 * the sandbox is still desired, and leaving the set cancels any pending timer —
 * closing the zombie-reconnect race against a stopped/deleted sandbox. */
const desired = new Set<string>();

export function syncAgentSubscriptions(
  sandboxIds: string[],
  queryClient: QueryClient,
) {
  desired.clear();
  for (const id of sandboxIds) desired.add(id);

  // Tear down connections + pending reconnect timers for sandboxes that left.
  for (const [sandboxId, sub] of connections) {
    if (!desired.has(sandboxId)) {
      sub.source?.close();
      if (sub.timer) clearTimeout(sub.timer);
      connections.delete(sandboxId);
    }
  }

  // Open for newly desired sandboxes.
  for (const sandboxId of desired) {
    if (!connections.has(sandboxId)) {
      connections.set(sandboxId, { source: null, timer: null });
      openStream(sandboxId, queryClient);
    }
  }
}

function openStream(sandboxId: string, queryClient: QueryClient) {
  const sub = connections.get(sandboxId);
  if (!sub || !desired.has(sandboxId)) return;

  const url = `${window.location.origin}/api/sandboxes/${sandboxId}/agent/events`;
  const source = new EventSource(url, { withCredentials: true });
  sub.source = source;

  source.addEventListener("agent", (evt) => {
    try {
      const event = JSON.parse((evt as MessageEvent).data) as AgentEvent;
      handleEvent(event, queryClient);
    } catch {
      // ignore malformed events
    }
  });

  source.onerror = () => {
    source.close();
    sub.source = null;
    if (!desired.has(sandboxId)) {
      connections.delete(sandboxId);
      return;
    }
    sub.timer = setTimeout(() => {
      sub.timer = null;
      openStream(sandboxId, queryClient);
    }, RECONNECT_DELAY_MS);
  };
}

function handleEvent(event: AgentEvent, queryClient: QueryClient) {
  switch (event.resource) {
    case "sessions":
      queryClient.invalidateQueries({
        queryKey: queryKeys.agent.sessions(event.sandboxId),
      });
      break;
    case "sessionStatuses":
      queryClient.invalidateQueries({
        queryKey: queryKeys.agent.sessionStatuses(event.sandboxId),
      });
      break;
    case "permissions":
      queryClient.invalidateQueries({
        queryKey: queryKeys.agent.permissions(event.sandboxId),
      });
      break;
    case "questions":
      queryClient.invalidateQueries({
        queryKey: queryKeys.agent.questions(event.sandboxId),
      });
      break;
    case "todos":
      if (event.sessionId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.agent.todos(event.sandboxId, event.sessionId),
        });
      }
      break;
  }
}
