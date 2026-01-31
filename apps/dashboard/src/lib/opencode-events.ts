import type { Event as OpencodeEvent } from "@opencode-ai/sdk/v2";
import type { QueryClient } from "@tanstack/react-query";
import { getOpencodeClient } from "@/api/opencode";
import { queryKeys } from "@/api/queries";

const connections = new Map<string, AbortController>();

export function syncOpencodeSubscriptions(
  urls: string[],
  queryClient: QueryClient,
) {
  const activeUrls = new Set(urls);

  for (const [url, controller] of connections) {
    if (!activeUrls.has(url)) {
      controller.abort();
      connections.delete(url);
    }
  }

  for (const url of urls) {
    if (connections.has(url)) continue;

    const controller = new AbortController();
    connections.set(url, controller);
    subscribeToEvents(url, controller, queryClient);
  }
}

async function subscribeToEvents(
  opencodeUrl: string,
  abortController: AbortController,
  queryClient: QueryClient,
) {
  const client = getOpencodeClient(opencodeUrl);

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
