/**
 * The server's top-level composition root — the only place all three modules
 * (runtime/control/sessions) are wired together. Mirrors v1 `container.ts`'s
 * manual-wiring convention.
 */
import type { ToolboxOwner, ToolsetRef } from "@atelier/spec";
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

/**
 * Resolve the caller's enabled toolboxes into built `ToolsetRef`s for a spawn
 * (entities-toolbox.md §5). Injection order is `[org enabled asc] → [user
 * enabled asc]`: the org's mandated baseline first, then the caller's personal
 * overlay, so a user's own toolbox shadows an org tool on a path conflict —
 * but only in that user's own sandboxes ("personal dotfiles win"). The
 * explicit `spec.toolsets` still win last (applied by the caller).
 *
 * `orgId` is optional (`undefined` skips the org tier — spawn bare, never
 * throw, Oracle refinement R1); `userId` is always present at the seam.
 * Each build uses a STABLE registry name keyed on the immutable owner
 * (`tb/${ownerType}/${ownerId}/${slug}`), so renaming an org never churns
 * artifacts or orphans a toolbox's repo (R2). `buildToolset` is content-hash
 * idempotent + inflight-deduped, so resolving fresh on every spawn (no memo
 * cache, R5) is cheap after the first build. A single toolbox's build
 * failure is logged and skipped — never fails the whole spawn.
 */
export async function resolveToolboxRefs(
  container: ServerContainer,
  { orgId, userId }: { orgId?: string; userId: string },
): Promise<ToolsetRef[]> {
  const owners: ToolboxOwner[] = [];
  if (orgId) owners.push({ type: "org", id: orgId });
  owners.push({ type: "user", id: userId });

  const refs: ToolsetRef[] = [];
  for (const owner of owners) {
    const configs = container.control.toolboxService.listEnabled(owner);
    for (const config of configs) {
      try {
        const ref = await container.runtime.buildToolset({
          name: `tb/${owner.type}/${owner.id}/${config.slug}`,
          source: config.source,
          build: config.build,
          paths: config.paths,
        });
        refs.push(ref);
      } catch (err) {
        log.error(
          { err, ownerType: owner.type, ownerId: owner.id, slug: config.slug },
          "toolbox build failed; skipping for this spawn",
        );
      }
    }
  }
  return refs;
}

/**
 * Backfill the default toolbox for every org that currently has zero
 * toolboxes (R4). Called non-blocking at startup so a restart never
 * resurrects a deliberately-deleted default, and never blocks boot on a DB
 * scan.
 */
export function ensureDefaultToolboxes(container: ServerContainer): void {
  const orgIds = container.control.organizationService
    .getAll()
    .map((org) => org.id);
  container.control.toolboxService.ensureDefaults(orgIds);
}
