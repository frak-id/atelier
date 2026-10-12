/**
 * The HTTP/MCP binding of the sandbox access rule (control/sandbox-access.ts):
 * resolve the sandbox's labels from the runtime and apply the rule. A denied
 * or unknown sandbox is the same `NotFoundError`, so existence is not leaked.
 */
import type { AuthUser, ControlContainer } from "../control/index.ts";
import { NotFoundError, UnauthorizedError } from "../shared/errors.ts";

/** The slice of the container the guard needs (MCP tests fake the runtime). */
interface SandboxGuardDeps {
  runtime: {
    getLabels(id: string):
      | {
          metadata: Record<string, string>;
          annotations: Record<string, string>;
        }
      | undefined;
  };
  control: Pick<ControlContainer, "canAccessSandbox">;
}

/** Throws `NotFoundError` unless `userId` may reach the sandbox. */
export function requireSandboxAccess(
  { runtime, control }: SandboxGuardDeps,
  userId: string,
  sandboxId: string,
): void {
  const labels = runtime.getLabels(sandboxId);
  if (!labels || !control.canAccessSandbox(userId, labels)) {
    throw new NotFoundError("Sandbox", sandboxId);
  }
}

/**
 * A sandbox-scoped snapshot (pause/manual/fork) is that sandbox's data: it
 * may only seed a new sandbox for callers who can access the owner. Shared
 * prebuild snapshots (no owner) stay open. Denied, or owner gone, is
 * `NotFoundError("Snapshot")` so existence is not revealed.
 */
export function requireSnapshotAccess(
  deps: SandboxGuardDeps & {
    runtime: { snapshotOwner(ref: string): string | undefined };
  },
  userId: string,
  ref: string,
): void {
  const owner = deps.runtime.snapshotOwner(ref);
  if (owner === undefined) return;
  const labels = deps.runtime.getLabels(owner);
  if (!labels || !deps.control.canAccessSandbox(userId, labels)) {
    throw new NotFoundError("Snapshot", ref);
  }
}

/** A spawn/build source (`{image}` or `{snapshot}`): only a snapshot can be
 * sandbox data. Absent or `null` (a cleared toolbox source) is fine. */
type SourceLike = { snapshot?: string } | { image?: string } | null | undefined;

/**
 * Every entry point that accepts a snapshot ref as a SOURCE (create, prebuild
 * chain, toolset build, toolbox/starter recipes) runs a pod over that disk:
 * check it with the CALLER's identity, synchronously, at write/dispatch time.
 * `recipe.prebuild` is the nested `PrebuildSpec` of a create request.
 */
export function requireSourceAccess(
  deps: Parameters<typeof requireSnapshotAccess>[0],
  userId: string,
  ...sources: SourceLike[]
): void {
  for (const source of sources) {
    if (source && "snapshot" in source && source.snapshot !== undefined) {
      requireSnapshotAccess(deps, userId, source.snapshot);
    }
  }
}

/** Keep only the listed sandboxes the caller may reach. */
export function accessibleSandboxes<
  T extends {
    metadata?: Record<string, string>;
    annotations?: Record<string, string>;
  },
>(
  { control }: Pick<SandboxGuardDeps, "control">,
  userId: string,
  sandboxes: T[],
): T[] {
  return sandboxes.filter((s) => control.canAccessSandbox(userId, s));
}

/**
 * The ONE guard of a router whose routes address `:id` as a sandbox id:
 * register it with `.onBeforeHandle(...)` right after the auth plugin. It
 * only acts on paths under `pathPrefix` (`/v1/sandboxes/`,
 * `/sessions/sandboxes/`), so a router can hold other `:id` routes. A request
 * without a resolved user is an `UnauthorizedError`, except a WS upgrade
 * (where the auth resolve is unreliable): the socket's own `open` check
 * calls `requireSandboxAccess` too.
 */
export function sandboxAccessGuard(
  container: SandboxGuardDeps,
  pathPrefix: string,
) {
  return ({
    params,
    user,
    request,
  }: {
    params?: Record<string, string | undefined>;
    user?: AuthUser;
    request: Request;
  }) => {
    if (!new URL(request.url).pathname.startsWith(pathPrefix)) return;
    const id = params?.id;
    if (id === undefined) return;
    if (!user) {
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") return;
      throw new UnauthorizedError();
    }
    requireSandboxAccess(container, user.id, id);
  };
}
