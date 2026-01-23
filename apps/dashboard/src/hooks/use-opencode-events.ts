import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import {
  type OpenCodeEvent,
  OpenCodeEventManager,
} from "@/api/opencode/events";
import { sandboxListQuery } from "@/api/queries";
import { queryKeys } from "@/api/query-keys";

export function useOpencodeEvents() {
  const queryClient = useQueryClient();
  const { data: sandboxes } = useQuery(sandboxListQuery());
  const managerRef = useRef<OpenCodeEventManager | null>(null);

  const runningSandboxes = useMemo(
    () => sandboxes?.filter((s) => s.status === "running") ?? [],
    [sandboxes],
  );

  const prevSandboxIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!managerRef.current) {
      managerRef.current = new OpenCodeEventManager();
    }

    const manager = managerRef.current;
    const currentSandboxIds = new Set(runningSandboxes.map((s) => s.id));

    for (const sandbox of runningSandboxes) {
      if (!manager.isSubscribed(sandbox.id)) {
        const baseUrl = sandbox.runtime.urls.opencode;

        manager.subscribe(sandbox.id, baseUrl, (event: OpenCodeEvent) => {
          handleEvent(queryClient, baseUrl, event);
        });
      }
    }

    for (const sandboxId of prevSandboxIdsRef.current) {
      if (!currentSandboxIds.has(sandboxId)) {
        manager.unsubscribe(sandboxId);
      }
    }

    prevSandboxIdsRef.current = currentSandboxIds;
  }, [runningSandboxes, queryClient]);

  useEffect(() => {
    return () => {
      managerRef.current?.unsubscribeAll();
    };
  }, []);
}

function handleEvent(
  queryClient: ReturnType<typeof useQueryClient>,
  baseUrl: string,
  event: OpenCodeEvent,
) {
  switch (event.type) {
    case "session.idle":
    case "session.status":
    case "session.created":
    case "message.updated":
      queryClient.invalidateQueries({
        queryKey: queryKeys.opencode.sessions(baseUrl),
      });
      break;

    case "connected":
      console.debug(`[SSE] Connected to ${baseUrl}`);
      break;

    case "disconnected":
      console.debug(`[SSE] Disconnected from ${baseUrl}`);
      break;

    case "error":
      console.error(`[SSE] Error from ${baseUrl}:`, event.error);
      break;
  }
}
