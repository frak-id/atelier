import { useMutation } from "@tanstack/react-query";
import type { Workspace } from "@/api/client";
import { api } from "@/api/client";
import {
  checkOpenCodeHealth,
  createOpenCodeSession,
  sendOpenCodeMessage,
} from "@/api/opencode";

const POLL_INTERVAL_MS = 1000;
const MAX_SANDBOX_POLL_ATTEMPTS = 60;
const MAX_OPENCODE_POLL_ATTEMPTS = 30;

async function waitForSandboxReady(sandboxId: string): Promise<string> {
  for (let i = 0; i < MAX_SANDBOX_POLL_ATTEMPTS; i++) {
    const { data: sandbox, error } = await api.api
      .sandboxes({ id: sandboxId })
      .get();

    if (error) throw new Error("Failed to fetch sandbox status");
    if (sandbox?.status === "error") {
      throw new Error(sandbox.runtime?.error ?? "Sandbox failed to start");
    }
    if (sandbox?.status === "running" && sandbox.runtime?.urls?.opencode) {
      return sandbox.runtime.urls.opencode;
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error("Sandbox did not become ready in time");
}

async function waitForOpenCodeReady(opencodeUrl: string): Promise<void> {
  for (let i = 0; i < MAX_OPENCODE_POLL_ATTEMPTS; i++) {
    const healthy = await checkOpenCodeHealth(opencodeUrl);
    if (healthy) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error("OpenCode did not become ready in time");
}

interface StartSessionParams {
  workspace: Workspace;
  message: string;
}

interface StartSessionResult {
  sandboxId: string;
  sessionId: string;
  sessionUrl: string;
}

async function startSession({
  workspace,
  message,
}: StartSessionParams): Promise<StartSessionResult> {
  const { data, error } = await api.api.sandboxes.post({
    workspaceId: workspace.id,
  });
  if (error || !data?.id) throw new Error("Failed to create sandbox");

  const sandboxId = data.id;
  const opencodeUrl = await waitForSandboxReady(sandboxId);
  await waitForOpenCodeReady(opencodeUrl);

  const directory = workspace.config.repos[0]?.clonePath ?? "/workspace";

  const sessionResult = await createOpenCodeSession(opencodeUrl, directory);
  if ("error" in sessionResult) throw new Error(sessionResult.error);

  const sessionId = sessionResult.sessionId;

  const sendResult = await sendOpenCodeMessage(
    opencodeUrl,
    sessionId,
    directory,
    message,
  );
  if ("error" in sendResult) throw new Error(sendResult.error);

  const sessionUrl = `${opencodeUrl}?session=${sessionId}`;
  window.open(sessionUrl, "_blank");

  return { sandboxId, sessionId, sessionUrl };
}

export function useStartSession() {
  return useMutation({
    mutationFn: startSession,
  });
}
