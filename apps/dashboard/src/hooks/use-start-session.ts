import type {
  StartSessionEvent,
  StartSessionStage,
} from "@frak/atelier-manager/types";
import { useMutation } from "@tanstack/react-query";
import type { Workspace } from "@/api/client";
import { api } from "@/api/client";
import type { TemplateConfig } from "@/api/opencode";

interface StartSessionParams {
  workspace: Workspace;
  message: string;
  templateConfig?: TemplateConfig;
  onProgress?: (stage: StartSessionStage) => void;
}

async function startSession({
  workspace,
  message,
  templateConfig,
  onProgress,
}: StartSessionParams) {
  const { data: stream, error } = await api.api.sandboxes["start-session"].post(
    {
      workspaceId: workspace.id,
      message,
      templateConfig,
    },
  );
  if (error) throw error;
  if (!stream) throw new Error("No stream returned from start-session");

  let done: Extract<StartSessionEvent, { type: "done" }> | undefined;

  for await (const chunk of stream) {
    const event = chunk as unknown as StartSessionEvent;
    switch (event.type) {
      case "progress":
        onProgress?.(event.stage);
        break;
      case "done":
        done = event;
        break;
      case "error":
        throw new Error(event.message);
    }
  }

  if (!done) {
    throw new Error("Session creation ended without a done event");
  }
  return done;
}

export function useStartSession() {
  return useMutation({
    mutationFn: startSession,
    onSuccess: (result) => {
      window.open(result.sessionUrl, "_blank");
    },
  });
}
