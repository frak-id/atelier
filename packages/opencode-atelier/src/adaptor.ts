import type {
  WorkspaceAdapter,
  WorkspaceInfo,
  WorkspaceTarget,
} from "@opencode-ai/plugin";
import { type AtelierClient, unwrap } from "./client.ts";
import { logger } from "./logger.ts";
import type { AtelierExtra, AtelierPluginConfig, Sandbox } from "./types.ts";

const ORIGIN_SOURCE = "opencode-plugin";
const CACHE_TTL_MS = 30_000;
const VM_HOME = "/home/dev";
const VM_WORKSPACE_DIR = `${VM_HOME}/workspace`;

/**
 * OpenCode-supplied env keys that must reach the remote `opencode serve`
 * for warp + workspace mode to function. We deliberately whitelist:
 *
 *   - OPENCODE_EXPERIMENTAL_WORKSPACES — unlocks the workspace adapter
 *     codepath on the remote.
 *   - OPENCODE_WORKSPACE_ID — lets the remote tag emitted events with the
 *     same workspace id the local CLI knows.
 *   - OPENCODE_AUTH_CONTENT — JSON dump of local auth so the remote
 *     can call LLM providers without separate auth sync.
 *   - OTEL_* — propagates tracing config.
 *
 * Anything else (host paths, local-only flags) is dropped on purpose.
 */
const FORWARDED_ENV_KEYS = [
  "OPENCODE_EXPERIMENTAL_WORKSPACES",
  "OPENCODE_WORKSPACE_ID",
  "OPENCODE_AUTH_CONTENT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_RESOURCE_ATTRIBUTES",
] as const;

function filterOpencodeEnv(
  env: Record<string, string | undefined> | undefined,
): Record<string, string> | undefined {
  if (!env) return undefined;
  const out: Record<string, string> = {};
  for (const key of FORWARDED_ENV_KEYS) {
    const value = env[key];
    if (typeof value === "string" && value.length > 0) {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Per-opencode-workspace runtime state.
 *
 * Opencode only persists the fields in `AtelierExtra`, so anything we learn
 * at create / lookup time lives here, keyed by the opencode workspace id.
 * Recoverable on demand via:
 *   GET /sandboxes?originSource=opencode-plugin&originExternalId=<workspaceId>
 */
type RuntimeEntry = {
  sandbox: Sandbox;
  fetchedAt: number;
};

const runtimeCache = new Map<string, RuntimeEntry>();

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
        branch: raw.branch ?? info.branch ?? undefined,
        // Capture local OpenCode identifiers so the remote sandbox can
        // pre-register the project_id before `/sync/replay` arrives.
        // See AtelierExtra docs for why this exists.
        sourceProjectID: info.projectID,
        sourceWorkspaceID: info.id,
      };

      // The remote sandbox boots OpenCode with `cd <workspaceDir>` where
      // `workspaceDir` is `/home/dev/workspace/<clonePath>` for single-repo
      // workspaces, else `/home/dev/workspace`. The remote project_id is
      // hashed from that path — if we announce a different directory here,
      // every `/sync/replay` batch fails its FK on insert because the events
      // carry a project_id the remote DB has never seen.
      const directory = await resolveWorkspaceDirectory(
        getClient,
        extra.atelierWorkspaceId,
      );

      return {
        ...info,
        name: info.name ?? `atelier-${info.id}`,
        directory,
        extra,
      };
    },

    async create(
      info: WorkspaceInfo,
      env: Record<string, string | undefined>,
      from?: WorkspaceInfo,
    ): Promise<void> {
      const extra = info.extra as AtelierExtra;
      if (!extra.atelierWorkspaceId) {
        throw new Error(
          "[atelier] atelierWorkspaceId is required " +
            "in workspace extra or ATELIER_WORKSPACE_ID env",
        );
      }

      const client = getClient();
      const branch = extra.branch ?? info.branch ?? undefined;
      const opencodeEnv = filterOpencodeEnv(env);

      logger.info(
        `Creating sandbox in workspace ${extra.atelierWorkspaceId}` +
          (branch ? ` (branch: ${branch})` : "") +
          (from?.id ? ` (forking from: ${from.id})` : "") +
          (opencodeEnv ? ` (env keys: ${Object.keys(opencodeEnv).join(",")})` : ""),
      );

      // POST /sandboxes blocks until the pod is running and OpenCode is
      // healthy, so no separate readiness wait is needed on the happy path.
      const sandbox = unwrap(
        await client.api.sandboxes.post({
          workspaceId: extra.atelierWorkspaceId,
          name: info.name,
          branch,
          origin: {
            source: ORIGIN_SOURCE,
            externalId: info.id,
          },
          // Forwarded so the manager can wire workspace mode + auth into
          // the remote `opencode serve` command and inject our pre-register
          // plugin via opencode.json. See manager `sandbox-config.ts` and
          // `internal.service.ts` for the receiving side.
          opencodeEnv,
          sourceProjectID: extra.sourceProjectID,
          sourceWorkspaceID: extra.sourceWorkspaceID,
          sourceWorkspaceFromID: from?.id,
        }),
      );

      logger.info(`Sandbox ${sandbox.id} ready (workspace ${info.id})`);

      runtimeCache.set(info.id, {
        sandbox: sandbox as Sandbox,
        fetchedAt: Date.now(),
      });
    },

    async remove(info: WorkspaceInfo): Promise<void> {
      const client = getClient();

      const sandboxId = await findSandboxId(client, info.id);
      if (!sandboxId) {
        logger.info(`No sandbox to remove for workspace ${info.id}`);
        runtimeCache.delete(info.id);
        return;
      }

      logger.info(`Destroying sandbox ${sandboxId} (workspace ${info.id})`);
      try {
        unwrap(await client.api.sandboxes({ id: sandboxId }).delete());
      } catch (err) {
        logger.warn(`Failed to delete sandbox ${sandboxId}: ${err}`);
      }

      runtimeCache.delete(info.id);
    },

    async target(info: WorkspaceInfo): Promise<WorkspaceTarget> {
      const client = getClient();

      const entry = await getRuntimeEntry(client, info.id);
      if (!entry || entry.sandbox.status !== "running") {
        const msg = `Sandbox not available for workspace ${info.id}`;
        logger.error(msg);
        throw new Error(`[atelier] ${msg}`);
      }

      const headers: Record<string, string> = {};
      const password = entry.sandbox.runtime.opencodePassword;
      if (password) {
        headers.Authorization = `Basic ${btoa(`opencode:${password}`)}`;
      }

      return {
        type: "remote",
        url: entry.sandbox.runtime.urls.opencode,
        headers,
      };
    },
  };
}

/**
 * Resolve the active sandbox for an opencode workspace.
 *
 * Priority:
 *   1. In-memory cache, if fresh.
 *   2. Refresh via the cached sandbox id (cheap when still valid).
 *   3. Discover the sandbox by `origin.externalId === info.id`,
 *      then fetch its full record.
 *   4. Stale cache as a last resort, so transient manager downtime doesn't
 *      tear down a working session.
 */
async function getRuntimeEntry(
  client: AtelierClient,
  workspaceId: string,
): Promise<RuntimeEntry | null> {
  const cached = runtimeCache.get(workspaceId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached;
  }

  if (cached) {
    const refreshed = await refreshSandbox(client, cached.sandbox.id);
    if (refreshed) {
      const entry: RuntimeEntry = {
        sandbox: refreshed,
        fetchedAt: Date.now(),
      };
      runtimeCache.set(workspaceId, entry);
      return entry;
    }
  }

  const discovered = await findSandboxByExternalId(client, workspaceId);
  if (discovered) {
    const entry: RuntimeEntry = {
      sandbox: discovered,
      fetchedAt: Date.now(),
    };
    runtimeCache.set(workspaceId, entry);
    return entry;
  }

  return cached ?? null;
}

async function refreshSandbox(
  client: AtelierClient,
  sandboxId: string,
): Promise<Sandbox | null> {
  try {
    const sandbox = unwrap(await client.api.sandboxes({ id: sandboxId }).get());
    if (sandbox.status !== "running") {
      logger.warn(
        `Sandbox ${sandboxId} status=${sandbox.status} (expected running)`,
      );
      return null;
    }
    return sandbox as Sandbox;
  } catch (err) {
    logger.warn(`Failed to refresh sandbox ${sandboxId}: ${err}`);
    return null;
  }
}

/**
 * Look up the most recently updated sandbox tagged with our origin source
 * and the given external id (= opencode workspace id).
 */
async function findSandboxByExternalId(
  client: AtelierClient,
  workspaceId: string,
): Promise<Sandbox | null> {
  try {
    const sandboxes = unwrap(
      await client.api.sandboxes.get({
        query: {
          originSource: ORIGIN_SOURCE,
          originExternalId: workspaceId,
        },
      }),
    );
    const running = sandboxes.find((s) => s.status === "running");
    if (running) return running as Sandbox;
    // Fall back to the most recently updated, even if not running, so the
    // caller can decide whether to surface the error.
    const sorted = [...sandboxes].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
    return (sorted[0] as Sandbox) ?? null;
  } catch (err) {
    logger.warn(
      `Failed to look up sandbox for workspace ${workspaceId}: ${err}`,
    );
    return null;
  }
}

async function findSandboxId(
  client: AtelierClient,
  workspaceId: string,
): Promise<string | null> {
  const cached = runtimeCache.get(workspaceId);
  if (cached) return cached.sandbox.id;

  const sandbox = await findSandboxByExternalId(client, workspaceId);
  return sandbox?.id ?? null;
}

/**
 * Resolve the directory the remote sandbox will actually `cd` into before
 * starting OpenCode. Mirrors the manager's `buildSandboxConfig` logic
 * (`apps/manager/src/orchestrators/sandbox-config.ts`):
 *
 *   - 1 repo  → `/home/dev/workspace/<clonePath>`
 *   - else    → `/home/dev/workspace`
 *
 * The remote OpenCode hashes this path to derive `project_id`; the local
 * CLI must announce the same path or `/sync/replay` will FK-fail when it
 * tries to insert events whose project_id doesn't exist on the remote.
 *
 * Best-effort: if the workspace lookup fails, we fall back to the parent
 * `/home/dev/workspace`, which still works for multi-repo setups.
 */
async function resolveWorkspaceDirectory(
  getClient: () => AtelierClient,
  atelierWorkspaceId: string,
): Promise<string> {
  if (!atelierWorkspaceId) return VM_WORKSPACE_DIR;
  try {
    const workspace = unwrap(
      await getClient().api.workspaces({ id: atelierWorkspaceId }).get(),
    );
    const repos = workspace.config?.repos ?? [];
    if (repos.length !== 1 || !repos[0]?.clonePath) {
      return VM_WORKSPACE_DIR;
    }
    // Mirror `buildSandboxConfig` byte-for-byte: the remote OpenCode `cd`s
    // into this exact string and hashes it for project_id, so any drift
    // (e.g. "/workspace/wallet" vs "/workspace/workspace/wallet") makes
    // /sync/replay fail its FK on insert.
    const clonePath = repos[0].clonePath;
    const suffix = clonePath.startsWith("/workspace")
      ? clonePath
      : `/workspace${clonePath}`;
    return `${VM_HOME}${suffix}`;
  } catch (err) {
    logger.warn(
      `Failed to resolve workspace directory for ${atelierWorkspaceId}, ` +
        `falling back to ${VM_WORKSPACE_DIR}: ${err}`,
    );
    return VM_WORKSPACE_DIR;
  }
}
