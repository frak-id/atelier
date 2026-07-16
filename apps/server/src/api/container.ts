/**
 * The server's top-level composition root — the only place all three modules
 * (runtime/control/sessions) are wired together. Manual-wiring convention
 * (no DI framework).
 */
import type {
  PortEntry,
  ProcessEntry,
  ToolboxConfig,
  ToolboxOwner,
  ToolsetRef,
} from "@atelier/spec";
import { createControlContainer, recipeFingerprint } from "../control/index.ts";
import {
  AgentClient,
  createImageBuilder,
  createSandboxBackend,
  DrizzleImageStore,
  DrizzleJobStore,
  DrizzleSandboxStore,
  DrizzleSandboxToolsetRefStore,
  DrizzleSnapshotStore,
  DrizzleToolsetStore,
  ImageBuilderService,
  JobService,
  RuntimeService,
} from "../runtime/index.ts";
import {
  AcpSessionSurface,
  AgentDispatch,
  registerHarnessDispatch,
  SessionService,
  TerminalService,
} from "../sessions/index.ts";
import { config } from "../shared/lib/config.ts";
import { createChildLogger } from "../shared/lib/logger.ts";

/**
 * Wire the built-in harnesses. Two independent, both OPTIONAL, extension
 * points — any ACP-speaking harness works with neither (the session surface
 * is one generic ACP-over-attach view for every harness):
 *  - compose-side `registerHarness`: server-side fallback composition when a
 *    toolbox/org-policy names a harness (client-composed specs bypass it);
 *  - `registerHarnessDispatch`: only for harnesses that translate a
 *    model/agent selection into ACP `session/set_config_option` (opencode
 *    does; pi and unknown harnesses dispatch config-free).
 */
async function registerBuiltinHarnesses(container: ServerContainer) {
  const { registerHarness, opencodeHarness, piHarness } = await import(
    "@atelier/compose"
  );
  registerHarness(opencodeHarness);
  registerHarness(piHarness);
  const { opencodeSessionConfig } = await import(
    "@atelier/compose/harnesses/opencode"
  );
  container.registerHarnessDispatch({
    id: "opencode",
    sessionConfig: opencodeSessionConfig,
  });
}

const log = createChildLogger("container");

export function createServerContainer() {
  const control = createControlContainer();
  // Construct the backend once and dial its resolved endpoint from the agent
  // (pod IP on k8s, mapped host ports on Docker) — the same instance is shared
  // with RuntimeService so there is a single source of endpoint truth.
  const backend = createSandboxBackend();
  const agent = new AgentClient((id) => backend.resolveAgentEndpoint(id));
  // One `images` store instance shared by the runtime (which reads it in
  // resolveImage to prefer a built image's pinned digest) and the image
  // builder service (which writes it) — a single source of truth for the
  // images table.
  const imageStore = new DrizzleImageStore();
  const runtime = new RuntimeService({
    agent,
    backend,
    sandboxes: new DrizzleSandboxStore(),
    snapshots: new DrizzleSnapshotStore(),
    toolsets: new DrizzleToolsetStore(),
    sandboxToolsetRefs: new DrizzleSandboxToolsetRefStore(),
    images: imageStore,
  });
  // Durable, observable lifecycle for long runtime ops (prebuild bake,
  // toolset build/capture, sandbox lifecycle) — the api/ seam dispatches
  // through it; internal spawn-time builds keep calling `runtime` directly
  // (no job noise). `concurrency` bounds the pooled build jobs.
  const jobs = new JobService({
    store: new DrizzleJobStore(),
    concurrency: config.jobs.concurrency,
  });
  const dispatch = new AgentDispatch({ agentClient: agent });
  const sessions = new SessionService({
    runtime,
    // One surface for every harness: they all speak ACP over the attach
    // bridge, so there is nothing per-harness to resolve.
    surface: (sandboxId) => new AcpSessionSurface(dispatch, sandboxId),
  });
  const terminal = new TerminalService({ agent });
  const images = new ImageBuilderService({
    store: imageStore,
    builder: createImageBuilder(),
    registryUrl: config.kubernetes.registryUrl,
    // Lazy read so it always reflects current runtime state — not captured
    // once at construction time (sandboxes/snapshots keep changing).
    referencedImageRefs: () => runtime.referencedImageRefs(),
    // Bridge image builds into the durable job feed for a single pane of
    // long ops. Execution stays entirely in ImageBuilderService; we just
    // `track` (unpooled — image builds have their own dedup/concurrency, and
    // must not queue behind prebuild/toolset jobs) a job that awaits the
    // already-running build and mirrors its outcome. Logs remain on
    // `/v1/images/:name/logs`. `.catch` swallows track's re-throw — the real
    // error is already recorded on the image record.
    onBuildStarted: (name, done) => {
      void jobs
        .track({ kind: "image-build", target: name }, async () => {
          const record = await done;
          if (record.status === "error") {
            throw new Error(record.error ?? "Image build failed");
          }
          return { ref: record.ref, digest: record.digest };
        })
        .catch(() => {});
    },
  });

  const serverContainer: ServerContainer = {
    control,
    runtime,
    jobs,
    agent,
    dispatch,
    sessions,
    terminal,
    images,
    registerHarnessDispatch,
  };
  return serverContainer;
}

export interface ServerContainer {
  control: ReturnType<typeof createControlContainer>;
  runtime: RuntimeService;
  jobs: JobService;
  images: ImageBuilderService;
  agent: AgentClient;
  dispatch: AgentDispatch;
  sessions: SessionService;
  terminal: TerminalService;
  registerHarnessDispatch: typeof registerHarnessDispatch;
}

/** Bootstrap hook: call once after `createServerContainer()`. */
export async function wireBuiltinHarnesses(container: ServerContainer) {
  await registerBuiltinHarnesses(container);
}

/**
 * Resolve one toolbox (for a given owner) to a `ToolsetRef`, or `undefined`
 * if it can't be resolved this spawn. Shared by `resolveToolboxRefs` (the
 * auto-inject tiers) and `resolveSelectedToolboxes` (explicit selectors) —
 * both need the same pinned-fast-path → build → lazy-record → log-and-skip
 * sequence, just over different toolbox sets.
 *
 * Pinned (docs/toolbox-versions.md §2): resolve straight to the saved ref,
 * skipping `buildToolset` entirely — no build, no content-hash lookup, just
 * the pointer. A dangling pin falls back to the recipe build (same
 * "never fail the whole spawn" resilience as the build path).
 *
 * Each build uses a STABLE registry name keyed on the immutable owner
 * (`tb/${ownerType}/${ownerId}/${slug}`), so renaming an org never churns
 * artifacts or orphans a toolbox's repo (R2). `buildToolset` is content-hash
 * idempotent + inflight-deduped, so resolving fresh on every spawn (no memo
 * cache, R5) is cheap after the first build. A single toolbox's build
 * failure is logged and skipped — never fails the whole spawn.
 */
async function resolveToolboxToRef(
  container: ServerContainer,
  owner: ToolboxOwner,
  config: ToolboxConfig,
): Promise<ToolsetRef | undefined> {
  const activeId = container.control.toolboxService.getActiveVersionId(
    config.id,
  );
  if (activeId) {
    const version = container.control.toolboxVersionService.find(activeId);
    if (version) return { ref: version.ref };
    log.warn(
      { slug: config.slug, activeId },
      "pinned toolbox version missing; falling back to recipe build",
    );
  }
  try {
    const { ref } = await container.runtime.buildToolset({
      name: `tb/${owner.type}/${owner.id}/${config.slug}`,
      source: config.source,
      build: config.build,
      paths: config.paths,
    });
    await recordBuiltVersionLazily(container, config, ref);
    return { ref };
  } catch (err) {
    log.error(
      { err, ownerType: owner.type, ownerId: owner.id, slug: config.slug },
      "toolbox build failed; skipping for this spawn",
    );
    return undefined;
  }
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
 */
export async function resolveToolboxRefs(
  container: ServerContainer,
  { orgId, userId }: { orgId?: string; userId: string },
): Promise<ToolsetRef[]> {
  const owners: ToolboxOwner[] = [];
  if (orgId) owners.push({ type: "org", id: orgId });
  owners.push({ type: "user", id: userId });

  // Resolve everything concurrently — builds are content-hash idempotent and
  // inflight-deduped, so parallel cold builds each get their own throwaway
  // pod instead of queuing. `Promise.all` preserves position, so the
  // org → user, oldest-first injection order is unchanged.
  const resolved = await Promise.all(
    owners.map((owner) =>
      Promise.all(
        container.control.toolboxService
          .listAutoInject(owner)
          .map((config) => resolveToolboxToRef(container, owner, config)),
      ),
    ),
  );
  return resolved.flat().filter((ref) => ref !== undefined);
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
  const resolved = await Promise.all(
    selectors.map((selector) => {
      const parsed = parseToolboxRef(selector);
      if (!parsed) return undefined;
      const config = container.control.toolboxService.getByOwnerAndSlug(
        parsed.owner,
        parsed.slug,
      );
      if (!config || config.build.length === 0 || config.paths.length === 0) {
        return undefined;
      }
      return resolveToolboxToRef(container, parsed.owner, config);
    }),
  );
  return resolved.filter((ref) => ref !== undefined);
}

/**
 * Lazily record a recipe-built artifact as a `built` version row, once per
 * distinct ref (docs/toolbox-versions.md §3) — so version history stays
 * complete even for toolboxes that never went through an explicit capture.
 * Gated on `existsByRef` first so the hot spawn path stays a single indexed
 * lookup once a ref has been recorded (the seam calls `buildToolset` every
 * spawn, but it's content-hash cached, so `ref` is stable until the recipe
 * changes). Recording a version row must never fail a spawn: every failure
 * is caught and logged only.
 */
async function recordBuiltVersionLazily(
  container: ServerContainer,
  config: ToolboxConfig,
  ref: string,
): Promise<void> {
  try {
    if (container.control.toolboxVersionService.existsByRef(config.id, ref)) {
      return;
    }
    const fp = recipeFingerprint(config);
    const sourceImage = await container.runtime
      .resolveSourceImage(
        config.source ?? { image: container.runtime.defaultImage() },
      )
      .catch(() => undefined);
    container.control.toolboxVersionService.recordBuilt(config.id, {
      ref,
      recipeFingerprint: fp,
      sourceImage,
    });
    pruneToolboxVersions(container, config.id);
  } catch (err) {
    log.error(
      { err, toolboxId: config.id, ref },
      "lazy built-version recording failed; spawn continues",
    );
  }
}

/**
 * Enforce the per-toolbox retention policy after a new version row is added
 * (docs/toolbox-versions.md §6) — called after both lazy `built` recording
 * and explicit capture. Also drops the runtime toolset record for any pruned
 * version (Zot retention handles the underlying blobs). Log-only: pruning
 * must never fail the caller's request. `deleteToolset` may now refuse a ref
 * still mounted by a live/paused sandbox (toolset-overlay-squashfs.md §7) —
 * the swallowing catch is exactly right for that: the version row stays
 * pruned from toolbox history, the runtime record just outlives it until the
 * last referencing sandbox destroys/resumes off it.
 */
export function pruneToolboxVersions(
  container: ServerContainer,
  toolboxId: string,
): void {
  try {
    const deleted = container.control.toolboxVersionService.pruneOldVersions(
      toolboxId,
      container.control.toolboxService.getActiveVersionId(toolboxId),
    );
    for (const v of deleted) {
      try {
        container.runtime.deleteToolset(v.ref);
      } catch {}
    }
  } catch (err) {
    log.error({ err, toolboxId }, "toolbox version retention prune failed");
  }
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
