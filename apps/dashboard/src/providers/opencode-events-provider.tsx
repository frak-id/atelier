import type { Event as OpencodeEvent } from "@opencode-ai/sdk/v2";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
} from "react";
import { queryKeys, sandboxListQuery } from "@/api/queries";

interface OpencodeEventsContextValue {
  connectedUrls: string[];
}

const OpencodeEventsContext = createContext<OpencodeEventsContextValue>({
  connectedUrls: [],
});

export function useOpencodeEvents() {
  return useContext(OpencodeEventsContext);
}

interface OpencodeEventsProviderProps {
  children: ReactNode;
}

export function OpencodeEventsProvider({
  children,
}: OpencodeEventsProviderProps) {
  const queryClient = useQueryClient();
  const connectionsRef = useRef<Map<string, AbortController>>(new Map());
  const connectedUrlsRef = useRef<string[]>([]);

  const { data: sandboxes } = useQuery(sandboxListQuery());

  const runningSandboxUrls =
    sandboxes
      ?.filter((s) => s.status === "running")
      .map((s) => s.runtime.urls.opencode) ?? [];

  useEffect(() => {
    const currentConnections = connectionsRef.current;
    const activeUrls = new Set(runningSandboxUrls);

    for (const [url, controller] of currentConnections) {
      if (!activeUrls.has(url)) {
        controller.abort();
        currentConnections.delete(url);
      }
    }

    for (const opencodeUrl of runningSandboxUrls) {
      if (currentConnections.has(opencodeUrl)) continue;

      const abortController = new AbortController();
      currentConnections.set(opencodeUrl, abortController);

      subscribeToEvents(opencodeUrl, abortController, queryClient);
    }

    connectedUrlsRef.current = [...activeUrls];

    return () => {
      for (const controller of currentConnections.values()) {
        controller.abort();
      }
      currentConnections.clear();
    };
  }, [runningSandboxUrls, queryClient]);

  return (
    <OpencodeEventsContext.Provider
      value={{ connectedUrls: connectedUrlsRef.current }}
    >
      {children}
    </OpencodeEventsContext.Provider>
  );
}

async function subscribeToEvents(
  opencodeUrl: string,
  abortController: AbortController,
  queryClient: ReturnType<typeof useQueryClient>,
) {
  const client = createOpencodeClient({ baseUrl: opencodeUrl });

  const handleEvent = (event: OpencodeEvent) => {
    switch (event.type) {
      case "session.created":
      case "session.updated":
      case "session.deleted":
        queryClient.invalidateQueries({
          queryKey: queryKeys.opencode.sessions(opencodeUrl),
        });
        break;
      case "session.status":
      case "session.idle":
        queryClient.invalidateQueries({
          queryKey: queryKeys.opencode.sessionStatuses(opencodeUrl),
        });
        break;
      case "permission.asked":
      case "permission.replied":
        queryClient.invalidateQueries({
          queryKey: queryKeys.opencode.permissions(opencodeUrl),
        });
        break;
      case "question.asked":
      case "question.replied":
      case "question.rejected":
        queryClient.invalidateQueries({
          queryKey: queryKeys.opencode.questions(opencodeUrl),
        });
        break;
      case "todo.updated":
        queryClient.invalidateQueries({
          queryKey: queryKeys.opencode.todos(
            opencodeUrl,
            event.properties.sessionID,
          ),
        });
        break;
    }
  };

  const connect = async () => {
    try {
      const result = await client.event.subscribe(undefined, {
        signal: abortController.signal,
        sseMaxRetryAttempts: 10,
        sseDefaultRetryDelay: 3000,
        sseMaxRetryDelay: 30000,
      });

      for await (const event of result.stream) {
        if (abortController.signal.aborted) break;
        handleEvent(event as OpencodeEvent);
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      console.warn(
        `OpenCode SSE subscription failed for ${opencodeUrl}:`,
        error,
      );

      if (!abortController.signal.aborted) {
        setTimeout(() => connect(), 5000);
      }
    }
  };

  connect();
}
