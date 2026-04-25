import { type AtelierClient, unwrap, waitForTaskSandbox } from "./client.ts";
import type {
  AtelierExtra,
  AtelierPluginConfig,
  Sandbox,
  WorkspaceAdaptor,
  WorkspaceInfo,
  WorkspaceTarget,
} from "./types.ts";

const sandboxCache = new Map<string, { sandbox: Sandbox; fetchedAt: number }>();
const CACHE_TTL_MS = 30_000;

export function createAtelierAdaptor(
  pluginConfig: AtelierPluginConfig,
  getClient: () => AtelierClient,
): WorkspaceAdaptor {
  return {
    name: "Atelier",
    description: "Spawn an Atelier sandbox and run OpenCode inside it",

    async configure(info: WorkspaceInfo): Promise<WorkspaceInfo> {
      const raw = (info.extra ?? {}) as Partial<AtelierExtra>;
      const extra: AtelierExtra = {
        managerUrl: raw.managerUrl ?? pluginConfig.managerUrl,
        atelierWorkspaceId:
          raw.atelierWorkspaceId ?? pluginConfig.workspaceId ?? "",
        description: raw.description ?? "OpenCode workspace",
        baseBranch: raw.baseBranch ?? undefined,
      };

      return {
        ...info,
        name: info.name ?? `atelier-${info.id}`,
        directory: "/home/dev/workspace",
        extra,
      };
    },

    async create(info: WorkspaceInfo): Promise<void> {
      const extra = info.extra as AtelierExtra;
      if (!extra.atelierWorkspaceId) {
        throw new Error(
          "[atelier] atelierWorkspaceId is required " +
            "in workspace extra or ATELIER_WORKSPACE_ID env",
        );
      }

      const client = getClient();

      const task = unwrap(
        await client.api.tasks.post({
          workspaceId: extra.atelierWorkspaceId,
          description: extra.description,
          baseBranch: extra.baseBranch,
        }),
      );

      extra.taskId = task.id;

      unwrap(await client.api.tasks({ id: task.id }).start.post());

      const { sandbox } = await waitForTaskSandbox(client, task.id, {
        intervalMs: pluginConfig.pollIntervalMs,
        timeoutMs: pluginConfig.pollTimeoutMs,
      });

      extra.sandboxId = sandbox.id;
      extra.sandboxOpencodeUrl = sandbox.runtime.urls.opencode;
      extra.opencodePassword = sandbox.runtime.opencodePassword;

      sandboxCache.set(info.id, {
        sandbox,
        fetchedAt: Date.now(),
      });
    },

    async remove(info: WorkspaceInfo): Promise<void> {
      const extra = info.extra as AtelierExtra;
      if (!extra.taskId) return;

      const client = getClient();
      try {
        unwrap(
          await client.api.tasks({ id: extra.taskId }).delete(undefined, {
            query: { sandboxAction: "destroy" },
          }),
        );
      } catch (err) {
        console.warn(`[atelier] Failed to delete task ${extra.taskId}: ${err}`);
      }

      sandboxCache.delete(info.id);
    },

    async target(info: WorkspaceInfo): Promise<WorkspaceTarget> {
      const extra = info.extra as AtelierExtra;
      const url = await resolveOpencodeUrl(info.id, extra, getClient);
      if (!url) {
        throw new Error(
          `[atelier] Sandbox not available for workspace ${info.id}`,
        );
      }

      const headers: Record<string, string> = {};
      if (extra.opencodePassword) {
        headers.Authorization = `Basic ${btoa(`opencode:${extra.opencodePassword}`)}`;
      }

      return { type: "remote", url, headers };
    },
  };
}

async function resolveOpencodeUrl(
  workspaceId: string,
  extra: AtelierExtra,
  getClient: () => AtelierClient,
): Promise<string | null> {
  if (extra.sandboxOpencodeUrl) {
    const cached = sandboxCache.get(workspaceId);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return extra.sandboxOpencodeUrl;
    }
  }

  if (!extra.sandboxId) return null;

  try {
    const client = getClient();
    const sandbox = unwrap(
      await client.api.sandboxes({ id: extra.sandboxId }).get(),
    );
    if (sandbox.status !== "running") return null;

    sandboxCache.set(workspaceId, {
      sandbox: sandbox as Sandbox,
      fetchedAt: Date.now(),
    });

    extra.sandboxOpencodeUrl = sandbox.runtime.urls.opencode;
    extra.opencodePassword = sandbox.runtime.opencodePassword;
    return sandbox.runtime.urls.opencode;
  } catch {
    return extra.sandboxOpencodeUrl ?? null;
  }
}
