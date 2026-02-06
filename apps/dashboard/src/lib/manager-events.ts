import type { ManagerEvent } from "@frak/atelier-manager/types";
import type { QueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { queryKeys } from "@/api/queries";

let controller: AbortController | null = null;

export function startManagerEvents(queryClient: QueryClient): void {
  if (controller) return;

  controller = new AbortController();
  connect(controller, queryClient);
}

export function stopManagerEvents(): void {
  if (!controller) return;
  controller.abort();
  controller = null;
}

function handleEvent(event: ManagerEvent, queryClient: QueryClient): void {
  const { type, properties } = event;

  switch (type) {
    case "sandbox.created":
    case "sandbox.deleted":
      queryClient.invalidateQueries({
        queryKey: queryKeys.sandboxes.all,
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.system.stats,
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.all,
      });
      break;

    case "sandbox.updated":
      queryClient.invalidateQueries({
        queryKey: queryKeys.sandboxes.all,
      });
      if (properties.id) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.sandboxes.detail(properties.id),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.sandboxes.services(properties.id),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.sandboxes.devCommands(properties.id),
        });
      }
      break;

    case "task.created":
    case "task.updated":
    case "task.deleted":
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.all,
      });
      if (properties.id) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.tasks.detail(properties.id),
        });
      }
      break;

    case "workspace.created":
    case "workspace.updated":
    case "workspace.deleted":
      queryClient.invalidateQueries({
        queryKey: queryKeys.workspaces.all,
      });
      if (properties.id) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.workspaces.detail(properties.id),
        });
      }
      queryClient.invalidateQueries({
        queryKey: queryKeys.sessionTemplates.all,
      });
      break;

    case "config.created":
    case "config.updated":
    case "config.deleted":
      queryClient.invalidateQueries({
        queryKey: queryKeys.configFiles.all,
      });
      break;

    case "sandbox.services.changed":
      if (properties.id) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.sandboxes.services(properties.id),
        });
      }
      break;

    case "sandbox.git.changed":
      if (properties.id) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.sandboxes.gitStatus(properties.id),
        });
      }
      break;
  }
}

async function connect(
  abortController: AbortController,
  queryClient: QueryClient,
): Promise<void> {
  try {
    const { data: stream } = await api.api.events.get({
      fetch: { signal: abortController.signal },
    });

    if (!stream) return;

    for await (const event of stream) {
      if (abortController.signal.aborted) break;
      handleEvent(event as unknown as ManagerEvent, queryClient);
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return;
    console.warn("Manager SSE connection failed:", error);
  }

  if (!abortController.signal.aborted) {
    setTimeout(() => connect(abortController, queryClient), 5000);
  }
}
