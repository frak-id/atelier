import { type AgentEvent, AgentEventSchema } from "@frak/atelier-shared";
import { Check } from "@sinclair/typebox/value";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { queryKeys } from "@/api/queries/keys";
import { httpUrl, isCrossOrigin } from "@/lib/api-base";

/**
 * Subscribe to a sandbox's agent SSE stream and turn each event into a
 * precise query invalidation. The server emits coarse `{resource, sessionId?}`
 * cache-invalidation signals (never payloads), so the client re-fetches the
 * matching query rather than mutating cache directly.
 *
 * Returns whether the stream is currently connected (EventSource auto-retries
 * on transient errors, so this flips without tearing the subscription down).
 */
export function useAgentEvents(sandboxId: string): { connected: boolean } {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const source = new EventSource(
      httpUrl(`/sessions/sandboxes/${sandboxId}/agent/events`),
      // Cross-origin (Tauri) needs credentialed SSE to send the auth cookie;
      // a no-op same-origin.
      { withCredentials: isCrossOrigin },
    );

    source.addEventListener("open", () => setConnected(true));
    source.addEventListener("error", () => setConnected(false));

    source.addEventListener("agent", (event) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!Check(AgentEventSchema, parsed)) return;
      invalidateForResource(queryClient, sandboxId, parsed);
    });

    return () => {
      source.close();
      setConnected(false);
    };
  }, [sandboxId, queryClient]);

  return { connected };
}

function invalidateForResource(
  queryClient: QueryClient,
  sandboxId: string,
  event: AgentEvent,
): void {
  const { sessions } = queryKeys;
  switch (event.resource) {
    case "sessions":
      queryClient.invalidateQueries({ queryKey: sessions.list(sandboxId) });
      break;
    case "sessionStatuses":
      queryClient.invalidateQueries({ queryKey: sessions.statuses(sandboxId) });
      break;
    case "permissions":
      queryClient.invalidateQueries({
        queryKey: sessions.permissions(sandboxId),
      });
      break;
    case "questions":
      queryClient.invalidateQueries({
        queryKey: sessions.questions(sandboxId),
      });
      break;
    case "todos":
      queryClient.invalidateQueries({
        queryKey: event.sessionId
          ? sessions.todos(sandboxId, event.sessionId)
          : [...sessions.all(sandboxId), "todos"],
      });
      break;
    default:
      event.resource satisfies never;
  }
}
