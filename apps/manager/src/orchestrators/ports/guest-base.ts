import { VM } from "@frak/atelier-shared/constants";
import type { AgentClient } from "../../infrastructure/agent/agent.client.ts";
import type { FileWrite } from "../../infrastructure/agent/agent.types.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";

const log = createChildLogger("guest-base");

// --- Pure command builders ---

// --- Pure file builders ---

export function buildRuntimeEnvFiles(env: Record<string, string>): FileWrite[] {
  const content = `${Object.entries(env)
    .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
    .join("\n")}\n`;
  return [
    {
      path: "/etc/sandbox/runtime.env",
      content,
      mode: "0644",
      owner: "root",
    },
    {
      path: "/etc/profile.d/98-atelier-runtime.sh",
      content:
        "[ -r /etc/sandbox/runtime.env ] && . /etc/sandbox/runtime.env\n",
      owner: "root",
    },
  ];
}

export function buildOhMyOpenCodeCacheFiles(providers: string[]): FileWrite[] {
  return [
    {
      path: `${VM.HOME}/.cache/oh-my-opencode/connected-providers.json`,
      content: JSON.stringify(
        { connected: providers, updatedAt: new Date().toISOString() },
        null,
        2,
      ),
      owner: "dev",
    },
  ];
}

export function buildSandboxMdFile(content: string): FileWrite[] {
  return [{ path: `${VM.HOME}/SANDBOX.md`, content, owner: "dev" }];
}

// --- Async command builders (host-side check → Command | null) ---

// --- True executors (can't be batched) ---

/**
 * Service names that block the user-facing flow. A failure to start any of
 * these is a hard failure: callers should not finalize the sandbox.
 */
const CRITICAL_SERVICES = new Set(["opencode"]);

export async function startServices(
  agent: AgentClient,
  sandboxId: string,
  serviceNames: string[],
): Promise<void> {
  const errors: { service: string; error: unknown }[] = [];
  await Promise.all(
    serviceNames.map(async (name) => {
      try {
        await agent.serviceStart(sandboxId, name);
      } catch (error) {
        errors.push({ service: name, error });
        if (!CRITICAL_SERVICES.has(name)) {
          log.warn(
            { sandboxId, service: name, error: String(error) },
            "Service start failed (non-critical)",
          );
        }
      }
    }),
  );

  const criticalFailure = errors.find((e) => CRITICAL_SERVICES.has(e.service));
  if (criticalFailure) {
    log.error(
      {
        sandboxId,
        service: criticalFailure.service,
        error: String(criticalFailure.error),
      },
      "Critical service failed to start",
    );
    throw new Error(
      `Failed to start critical service '${criticalFailure.service}': ${
        criticalFailure.error instanceof Error
          ? criticalFailure.error.message
          : String(criticalFailure.error)
      }`,
    );
  }

  log.info({ sandboxId, services: serviceNames }, "Services started");
}

/**
 * Refuses paths we should never write to: relative paths, paths with NULs,
 * the root, the `dev` user's home, and the canonical workspace tree itself.
 *
 * Mostly defensive — the local CLI's cwd is normally a real absolute path,
 * but this guards against accidental misuse from a malformed plugin
 * payload.
 */
function isPlausibleSourceDirectory(p: string): boolean {
  if (!p.startsWith("/")) return false;
  if (p.includes("\0")) return false;
  if (p === "/" || p === "/home" || p === "/home/dev") return false;
  if (p.startsWith("/home/dev/workspace")) return false;
  return true;
}

/**
 * Mint a symlink in the sandbox at `<sourceLocalDirectory>` → `workspaceDir`.
 *
 * Why: the local TUI configures `@opencode-ai/sdk` with `directory =
 * <local cwd>` (e.g. `/Users/alice/Workspace/...`). The SDK auto-injects
 * `?directory=<encoded local cwd>` into every GET. After warp, opencode's
 * `WorkspaceRouter` proxies these to us preserving the query, and the
 * remote's `InstanceMiddleware` uses `query.directory > header > cwd`,
 * so it would otherwise bootstrap a phantom instance at the local path
 * (which doesn't exist on the VM). Pre-creating the symlink makes that
 * path resolve to the real workspace dir, so `Project.fromDirectory`
 * walks up to the same `.git`, reads the same cached `project_id`, and
 * the TUI lands on a working instance.
 *
 * Best-effort: a failure here means warp will hit the phantom-instance
 * bug, but the rest of the sandbox still works.
 */
export async function mintSourceDirectorySymlink(
  agent: AgentClient,
  sandboxId: string,
  sourceLocalDirectory: string,
  workspaceDir: string,
): Promise<void> {
  if (!isPlausibleSourceDirectory(sourceLocalDirectory)) {
    log.warn(
      { sandboxId, sourceLocalDirectory },
      "Refusing to mint symlink for implausible source directory",
    );
    return;
  }

  const parent = posixDirname(sourceLocalDirectory);
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  // `-sfn`: symlink, force-overwrite, don't dereference if `<source>` is
  // already a symlink to a dir (avoids `<source>/<source>` recursion on
  // re-warp). `mkdir -p` creates the chain `/Users/.../Workspace/Frak`
  // so the leaf `ln -s` lands. Needs root because `/Users` doesn't exist
  // and `dev` can't write to `/`.
  const cmd = `mkdir -p ${q(parent)} && ln -sfn ${q(workspaceDir)} ${q(sourceLocalDirectory)}`;
  const result = await agent.exec(sandboxId, cmd, {
    user: "root",
    timeout: 10_000,
  });
  if (result.exitCode !== 0) {
    log.warn(
      { sandboxId, sourceLocalDirectory, workspaceDir, stderr: result.stderr },
      "Failed to mint source-directory symlink — warp may hit phantom-instance bug",
    );
    return;
  }
  log.info(
    { sandboxId, sourceLocalDirectory, workspaceDir },
    "Minted source-directory symlink",
  );
}

function posixDirname(p: string): string {
  const idx = p.lastIndexOf("/");
  if (idx <= 0) return "/";
  return p.slice(0, idx);
}
