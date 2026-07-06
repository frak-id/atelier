/**
 * The server's top-level composition root — the only place all three modules
 * (runtime/control/sessions) are wired together. Mirrors v1 `container.ts`'s
 * manual-wiring convention.
 */
import type {
  PortEntry,
  ProcessEntry,
  ToolboxOwner,
  ToolsetRef,
} from "@atelier/spec";
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
  // Register the compose-side harness composers (spec fragments) so the api/
  // seam can materialize a toolbox-declared harness into a spawn's spec.
  const { registerHarness, opencodeHarness, piHarness } = await import(
    "@atelier/compose"
  );
  registerHarness(opencodeHarness);
  registerHarness(piHarness);
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
    const configs = container.control.toolboxService.listAutoInject(owner);
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
 * Build the toolsets for an explicitly-selected set of toolboxes
 * (`tb/<owner>/<slug>` selectors from the spawn UI). Mirrors
 * `resolveToolboxRefs` but for the picked set rather than the auto-inject set,
 * and only for toolboxes that carry files: a process-only toolbox (browser)
 * has no `build`/`paths`, so it produces no toolset — its surface is applied
 * separately from the selector. A single toolbox's build failure is logged
 * and skipped, never fails the spawn.
 */
export async function resolveSelectedToolboxes(
  container: ServerContainer,
  selectors: string[],
): Promise<ToolsetRef[]> {
  const refs: ToolsetRef[] = [];
  for (const selector of selectors) {
    const parsed = parseToolboxRef(selector);
    if (!parsed) continue;
    const config = container.control.toolboxService.getByOwnerAndSlug(
      parsed.owner,
      parsed.slug,
    );
    if (!config || config.build.length === 0 || config.paths.length === 0) {
      continue;
    }
    try {
      refs.push(
        await container.runtime.buildToolset({
          name: `tb/${parsed.owner.type}/${parsed.owner.id}/${config.slug}`,
          source: config.source,
          build: config.build,
          paths: config.paths,
        }),
      );
    } catch (err) {
      log.error(
        { err, ownerType: parsed.owner.type, slug: parsed.slug },
        "selected toolbox build failed; skipping for this spawn",
      );
    }
  }
  return refs;
}

/** Parse a toolbox toolset ref/name back to its owner+slug (the inverse of the
 * `tb/${ownerType}/${ownerId}/${slug}` naming). Returns undefined for refs
 * that aren't toolbox artifacts. */
function parseToolboxRef(
  ref: string,
): { owner: ToolboxOwner; slug: string } | undefined {
  const match = ref.match(/(?:^|\/)tb\/(org|user)\/([^/]+)\/([^/@]+)(?:@|$)/);
  const [, ownerType, ownerId, slug] = match ?? [];
  if (!ownerType || !ownerId || !slug) return undefined;
  return {
    owner: { type: ownerType as ToolboxOwner["type"], id: ownerId },
    slug,
  };
}

/**
 * The harness the toolbox behind a single toolset name declares, if any.
 * Viewer-independent (unlike the compose map): looks the toolbox up by the
 * owner+slug encoded in the `tb/<owner>/<slug>` name. Used to enrich the
 * global toolset list so the compose surface can tag any toolset.
 */
export function harnessForToolset(
  container: ServerContainer,
  name: string,
): string | undefined {
  const parsed = parseToolboxRef(name);
  if (!parsed) return undefined;
  return container.control.toolboxService.getByOwnerAndSlug(
    parsed.owner,
    parsed.slug,
  )?.harness;
}

/**
 * Resolve the winning harness a spawn's toolboxes declare (entities-toolbox.md).
 * Considers every toolbox whose toolset is present in this spawn — auto-
 * injected (enabled) and explicitly selected `spec.toolsets` alike. A
 * user-owned toolbox's harness wins over an org-owned one (the personal
 * overlay beats the mandated baseline). Returns undefined when no toolbox
 * declares a harness; the caller then falls back to org policy.
 */
export function resolveToolboxHarness(
  container: ServerContainer,
  refs: { ref: string }[],
): string | undefined {
  let userHarness: string | undefined;
  let orgHarness: string | undefined;
  for (const { ref } of refs) {
    const parsed = parseToolboxRef(ref);
    if (!parsed) continue;
    const config = container.control.toolboxService.getByOwnerAndSlug(
      parsed.owner,
      parsed.slug,
    );
    if (!config?.harness) continue;
    if (parsed.owner.type === "user") userHarness = config.harness;
    else orgHarness = config.harness;
  }
  return userHarness ?? orgHarness;
}

/**
 * Collect the processes + ports every toolbox applied to this spawn
 * contributes (entities-toolbox.md). A toolbox is not just files: it can carry
 * a tool's *running surface* — vscode's `code-server` process + its port, or
 * the browser stack's kasmvnc/openbox/chromium (binaries baked into the base
 * image, so no `build`/`paths`). `refs` is the full applied set (auto-injected
 * + explicitly selected). Returns a spec fragment the caller merges in.
 */
export function resolveToolboxSurface(
  container: ServerContainer,
  refs: { ref: string }[],
): { processes: ProcessEntry[]; ports: PortEntry[] } {
  const processes: ProcessEntry[] = [];
  const ports: PortEntry[] = [];
  const seen = new Set<string>();
  for (const { ref } of refs) {
    const parsed = parseToolboxRef(ref);
    if (!parsed) continue;
    // A toolbox can be present twice (auto-injected + selected); apply once.
    const key = `${parsed.owner.type}/${parsed.owner.id}/${parsed.slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const config = container.control.toolboxService.getByOwnerAndSlug(
      parsed.owner,
      parsed.slug,
    );
    if (config?.processes) processes.push(...config.processes);
    if (config?.ports) ports.push(...config.ports);
  }
  return { processes, ports };
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
