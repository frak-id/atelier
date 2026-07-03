/**
 * The server's top-level composition root — the only place all three modules
 * (runtime/control/sessions) are wired together. Mirrors v1 `container.ts`'s
 * manual-wiring convention.
 */
import { orgToolboxRequest } from "@atelier/compose";
import type { ToolsetRef } from "@atelier/spec";
import { createControlContainer } from "../control/index.ts";
import {
  AgentClient,
  DrizzleSandboxStore,
  DrizzleSnapshotStore,
  DrizzleToolsetStore,
  RuntimeService,
} from "../runtime/index.ts";
import {
  AgentDispatch,
  type HarnessSessionSurface,
  registerHarnessDispatch,
  SessionService,
  type SessionSurfaceResolver,
  TerminalService,
} from "../sessions/index.ts";
import { createChildLogger } from "../shared/lib/logger.ts";

/**
 * Session-surface registry — the harness-neutral injection point for the live
 * session facade. The concrete surface is registered by
 * `registerBuiltinHarnesses()` below, kept as a separate step so
 * `container.ts` itself has zero harness knowledge.
 */
class SessionSurfaceRegistry implements SessionSurfaceResolver {
  private readonly factories = new Map<
    string,
    (sandboxId: string) => HarnessSessionSurface
  >();

  register(id: string, factory: (sandboxId: string) => HarnessSessionSurface) {
    this.factories.set(id, factory);
  }

  resolve(sandboxId: string, harnessId?: string): HarnessSessionSurface {
    const id = harnessId ?? "opencode";
    const factory = this.factories.get(id);
    if (!factory) {
      throw new Error(
        `No session surface registered for harness "${id}". Register one ` +
          "via container.sessionSurfaces.register() at bootstrap.",
      );
    }
    return factory(sandboxId);
  }
}

/**
 * Register the built-in opencode harness — the only concrete harness that
 * exists today (atelier-v2 §6 milestone 3 note: "single concrete adapter
 * avoids dead multi-harness scaffolding"). Composition (spec pieces) comes
 * from `@atelier/compose`; the session-surface HTTP client stays in
 * `sessions/harnesses/opencode` since it's an ACP-facade concern, not spec
 * composition.
 */
async function registerBuiltinHarnesses(container: ServerContainer) {
  const { opencodeSessionConfig } = await import(
    "@atelier/compose/harnesses/opencode"
  );
  const { AcpSessionSurface } = await import(
    "../sessions/acp/acp-session-surface.ts"
  );
  container.registerHarnessDispatch({
    id: "opencode",
    sessionConfig: opencodeSessionConfig,
  });
  // The opencode harness's live surface is ACP-over-attach in v2 (the shared
  // dispatch hub), not `opencode serve` HTTP (which has no port in v2).
  container.sessionSurfaces.register(
    "opencode",
    (sandboxId) => new AcpSessionSurface(container.dispatch, sandboxId),
  );
}

const log = createChildLogger("container");

export function createServerContainer() {
  const control = createControlContainer();
  const agent = new AgentClient();
  const runtime = new RuntimeService({
    agent,
    sandboxes: new DrizzleSandboxStore(),
    snapshots: new DrizzleSnapshotStore(),
    toolsets: new DrizzleToolsetStore(),
  });
  const dispatch = new AgentDispatch({ agentClient: agent });
  const sessionSurfaces = new SessionSurfaceRegistry();
  const sessions = new SessionService({ runtime, surfaces: sessionSurfaces });
  const terminal = new TerminalService({ agent });

  const serverContainer: ServerContainer = {
    control,
    runtime,
    agent,
    dispatch,
    sessions,
    terminal,
    sessionSurfaces,
    registerHarnessDispatch,
    // Resolved by `ensureOrgToolbox` right after construction; `/v1/sandboxes`
    // awaits this before injecting the toolbox ref (never server startup —
    // see `ensureOrgToolbox`).
    orgToolboxReady: Promise.resolve(undefined),
  };
  return serverContainer;
}

export interface ServerContainer {
  control: ReturnType<typeof createControlContainer>;
  runtime: RuntimeService;
  agent: AgentClient;
  dispatch: AgentDispatch;
  sessions: SessionService;
  terminal: TerminalService;
  sessionSurfaces: SessionSurfaceRegistry;
  registerHarnessDispatch: typeof registerHarnessDispatch;
  /** Resolves to the org toolbox's ref once built (or `undefined` if the
   * build failed — spawns then proceed without it rather than wedge). */
  orgToolboxReady: Promise<ToolsetRef | undefined>;
}

/** Bootstrap hook: call once after `createServerContainer()`. */
export async function wireBuiltinHarnesses(container: ServerContainer) {
  await registerBuiltinHarnesses(container);
}

/**
 * Ensure the org toolbox (opencode + code-server, replacing `shared-binaries`
 * — composed-prebuild-volumes.md §6) exists as a built toolset artifact.
 * `runtime.buildToolset` is content-hash idempotent, so a restart is an
 * instant store hit, not a rebuild. Runs in the BACKGROUND: the first build
 * (~30-90s: throwaway pod, two curls, tar, oras push) must not block server
 * startup or crash-loop the process on a transient registry hiccup. Callers
 * that need the ref (the `/v1/sandboxes` seam) await `container.orgToolboxReady`
 * instead, so only the first spawn (not the server) waits on it.
 */
export function ensureOrgToolbox(container: ServerContainer): void {
  container.orgToolboxReady = container.runtime
    .buildToolset(orgToolboxRequest)
    .catch((err) => {
      log.error({ err }, "org toolbox build failed; spawns proceed without it");
      return undefined;
    });
}
