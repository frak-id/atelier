/**
 * The server's top-level composition root — the only place all three modules
 * (runtime/control/sessions) are wired together. Mirrors v1 `container.ts`'s
 * manual-wiring convention.
 */
import { createControlContainer } from "../control/index.ts";
import {
  AgentClient,
  DrizzleCatalogStore,
  DrizzleSandboxStore,
  DrizzleSnapshotStore,
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

/**
 * Session-surface registry — the injection point v1's `agent-facade.routes.ts`
 * filled with an inline `new OpencodeSessionSurface(...)`. The concrete
 * opencode surface is registered by `registerBuiltinHarnesses()` below, kept
 * as a separate step so `container.ts` itself has zero opencode knowledge.
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
  // dispatch hub), not `opencode serve` HTTP. v1's OpencodeSessionSurface is
  // dead here — deleted with the rest of v1 in M6.
  container.sessionSurfaces.register(
    "opencode",
    (sandboxId) => new AcpSessionSurface(container.dispatch, sandboxId),
  );
}

export function createServerContainer() {
  const control = createControlContainer();
  const agent = new AgentClient();
  const runtime = new RuntimeService({
    agent,
    sandboxes: new DrizzleSandboxStore(),
    snapshots: new DrizzleSnapshotStore(),
    catalog: new DrizzleCatalogStore(),
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
}

/** Bootstrap hook: call once after `createServerContainer()`. */
export async function wireBuiltinHarnesses(container: ServerContainer) {
  await registerBuiltinHarnesses(container);
}
