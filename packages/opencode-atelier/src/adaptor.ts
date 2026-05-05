import type {
  WorkspaceAdapter,
  WorkspaceInfo,
  WorkspaceTarget,
} from "@opencode-ai/plugin";
import { type AtelierClient, unwrap, waitForTaskSandbox } from "./client.ts";
import { logger } from "./logger.ts";
import type { AtelierExtra, AtelierPluginConfig, Sandbox } from "./types.ts";

const sandboxCache = new Map<string, { sandbox: Sandbox; fetchedAt: number }>();
const CACHE_TTL_MS = 30_000;

export function createAtelierAdaptor(
  pluginConfig: AtelierPluginConfig,
  getClient: () => AtelierClient,
): WorkspaceAdapter {
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

      logger.info(
        `Creating task in workspace ${extra.atelierWorkspaceId}` +
          (extra.baseBranch ? ` (branch: ${extra.baseBranch})` : ""),
      );
      const task = unwrap(
        await client.api.tasks.post({
          workspaceId: extra.atelierWorkspaceId,
          description: extra.description,
          baseBranch: extra.baseBranch,
          integration: {
            source: "opencode-plugin",
            threadKey: info.id,
          },
        }),
      );

      extra.taskId = task.id;
      logger.info(`Task ${task.id} created, starting...`);

      unwrap(await client.api.tasks({ id: task.id }).start.post());

      const startedAt = Date.now();
      const { sandbox } = await waitForTaskSandbox(client, task.id, {
        intervalMs: pluginConfig.pollIntervalMs,
        timeoutMs: pluginConfig.pollTimeoutMs,
      });
      logger.info(
        `Sandbox ${sandbox.id} ready in ${Date.now() - startedAt}ms (task ${task.id})`,
      );

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
      logger.info(`Removing task ${extra.taskId} (workspace ${info.id})`);
      try {
        unwrap(
          await client.api.tasks({ id: extra.taskId }).delete(undefined, {
            query: { sandboxAction: "destroy" },
          }),
        );
      } catch (err) {
        logger.warn(`Failed to delete task ${extra.taskId}: ${err}`);
      }

      sandboxCache.delete(info.id);
    },

    async target(info: WorkspaceInfo): Promise<WorkspaceTarget> {
      const extra = info.extra as AtelierExtra;
      const url = await resolveOpencodeUrl(info.id, extra, getClient);
      if (!url) {
        const msg = `Sandbox not available for workspace ${info.id}`;
        logger.error(msg);
        throw new Error(`[atelier] ${msg}`);
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
    if (sandbox.status !== "running") {
      logger.warn(
        `Sandbox ${extra.sandboxId} status=${sandbox.status} (expected running)`,
      );
      return null;
    }

    sandboxCache.set(workspaceId, {
      sandbox: sandbox as Sandbox,
      fetchedAt: Date.now(),
    });

    extra.sandboxOpencodeUrl = sandbox.runtime.urls.opencode;
    extra.opencodePassword = sandbox.runtime.opencodePassword;
    return sandbox.runtime.urls.opencode;
  } catch (err) {
    // Don't swallow — a stale URL hides real backend failures. We do still
    // return the cached URL as a last resort so transient manager downtime
    // doesn't tear down a working session.
    logger.warn(
      `Failed to refresh sandbox ${extra.sandboxId} from manager: ${err}`,
    );
    return extra.sandboxOpencodeUrl ?? null;
  }
}
