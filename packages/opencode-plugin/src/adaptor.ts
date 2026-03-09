import {
  type AtelierClient,
  createClient,
  unwrap,
  waitForTaskSandbox,
} from "./atelier-api.ts";
import type {
  Adaptor,
  AtelierExtra,
  AtelierPluginConfig,
  Sandbox,
  WorkspaceInfo,
} from "./types.ts";

const sandboxCache = new Map<string, { sandbox: Sandbox; fetchedAt: number }>();
const CACHE_TTL_MS = 30_000;

export function createAtelierAdaptor(
  pluginConfig: AtelierPluginConfig,
): Adaptor {
  return {
    async configure(info: WorkspaceInfo): Promise<WorkspaceInfo> {
      const raw = (info.extra ?? {}) as Partial<AtelierExtra>;
      const extra: AtelierExtra = {
        managerUrl: raw.managerUrl ?? pluginConfig.managerUrl,
        atelierWorkspaceId:
          raw.atelierWorkspaceId ?? pluginConfig.defaultWorkspaceId ?? "",
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
          "[atelier-plugin] atelierWorkspaceId is required " +
            "in workspace extra or ATELIER_WORKSPACE_ID env",
        );
      }

      const client = createClient(extra.managerUrl, pluginConfig.token);

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

      const client = createClient(extra.managerUrl, pluginConfig.token);
      try {
        unwrap(
          await client.api.tasks({ id: extra.taskId }).delete(undefined, {
            query: { sandboxAction: "destroy" },
          }),
        );
      } catch (err) {
        console.warn(
          `[atelier-plugin] Failed to delete task ${extra.taskId}: ${err}`,
        );
      }

      sandboxCache.delete(info.id);
    },

    async fetch(
      info: WorkspaceInfo,
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> {
      const extra = info.extra as AtelierExtra;

      const opencodeUrl = await resolveOpencodeUrl(
        info.id,
        extra,
        pluginConfig.token,
      );
      if (!opencodeUrl) {
        return new Response("Sandbox not available", {
          status: 503,
        });
      }

      const inputUrl = input instanceof Request ? input.url : input.toString();
      const targetUrl = new URL(inputUrl, opencodeUrl);

      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );

      headers.set(
        "x-opencode-directory",
        info.directory ?? "/home/dev/workspace",
      );
      headers.set("x-opencode-workspace", info.id);

      if (extra.opencodePassword) {
        const encoded = btoa(`opencode:${extra.opencodePassword}`);
        headers.set("Authorization", `Basic ${encoded}`);
      }

      return fetch(targetUrl, {
        ...init,
        headers,
        body:
          init?.method === "GET" || init?.method === "HEAD"
            ? undefined
            : init?.body,
      });
    },
  };
}

async function resolveOpencodeUrl(
  workspaceId: string,
  extra: AtelierExtra,
  token?: string,
): Promise<string | null> {
  if (extra.sandboxOpencodeUrl) {
    const cached = sandboxCache.get(workspaceId);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return extra.sandboxOpencodeUrl;
    }
  }

  if (!extra.sandboxId) return null;

  try {
    const client = createClient(extra.managerUrl, token);
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
