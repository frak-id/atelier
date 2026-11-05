/**
 * The server's top-level composition root — the only place all three modules
 * (runtime/control/sessions) are wired together. Manual-wiring convention
 * (no DI framework).
 */
import { mergeSpecs } from "@atelier/compose";
import {
  type PortEntry,
  type ProcessEntry,
  type RuntimeSurface,
  type SandboxSpec,
  type ToolboxConfig,
  type ToolsetRef,
  toolboxArtifactName,
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
  AgentDispatch,
  AgentTaskService,
  registerHarnessDispatch,
  SessionService,
  TerminalService,
} from "../sessions/index.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import { registryUrl } from "../shared/lib/runtime-config.ts";
import { IdleReaper } from "./idle-reaper.ts";

/**
 * Wire the built-in harnesses. Two independent, both OPTIONAL, extension
 * points — any ACP-speaking harness works with neither (the session API is
 * one generic ACP-over-attach view for every harness):
 *  - compose-side `registerHarness`: server-side fallback composition when a
 *    toolbox names a harness (client-composed specs bypass it);
 *  - `registerHarnessDispatch`: only for harnesses that send status text of
 *    their own as message chunks (pi), which tasks leave out of the agent's
 *    reply; unknown harnesses dispatch as is.
 */
async function registerBuiltinHarnesses(container: ServerContainer) {
  const {
    registerHarness,
    opencodeHarness,
    piHarness,
    piIsNotice,
    piStartupNotice,
  } = await import("@atelier/compose");
  registerHarness(opencodeHarness);
  registerHarness(piHarness);
  container.registerHarnessDispatch({
    id: "pi",
    startupNotice: piStartupNotice,
    isNotice: piIsNotice,
  });
}

const log = createChildLogger("container");

export function createServerContainer() {
  const control = createControlContainer();
  // Construct the backend once and dial its resolved endpoint from the agent
  // (pod IP on k8s, mapped host ports on Docker) — the same instance is shared
  // with RuntimeService so there is a single source of endpoint truth.
  const backend = createSandboxBackend();
  // The agent requires a per-sandbox bearer token: a booting sandbox hands it
  // to the client directly, an already-booted one is read off its record.
  const sandboxStore = new DrizzleSandboxStore();
  const agent = new AgentClient(
    (id) => backend.resolveAgentEndpoint(id),
    (id) => sandboxStore.get(id)?.generated?.agentPassword,
  );
  // One `images` store instance shared by the runtime (which reads it in
  // resolveImage to prefer a built image's pinned digest) and the image
  // builder service (which writes it) — a single source of truth for the
  // images table.
  const imageStore = new DrizzleImageStore();
  const runtime = new RuntimeService({
    agent,
    backend,
    sandboxes: sandboxStore,
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
    // Lazy so a live edit to jobs.concurrency re-bounds the pool.
    concurrency: () => control.serverConfigService.get("jobs.concurrency"),
  });
  const dispatch = new AgentDispatch({
    agentClient: agent,
    // sessions/ only sees a callback; the idle rules live in control/.
    onActivity: (sandboxId) => runtime.touch(sandboxId, "agent"),
  });
  const sessions = new SessionService({ runtime, dispatch });
  // Fire-and-forget agent prompts (MCP `send_prompt`): server-driven ACP
  // sessions with captured replies. In-memory; see task.service.ts.
  const tasks = new AgentTaskService({ runtime, dispatch });
  const terminal = new TerminalService({ agent });
  // Idle auto-pause: the operator's rule (control) over the runtime's
  // activity clocks, blocked by ACP work in flight (sessions).
  const idle = new IdleReaper({
    runtime,
    jobs,
    dispatch,
    policy: control.idlePolicyService,
  });
  const images = new ImageBuilderService({
    store: imageStore,
    // Both read lazily so a live edit to the registry URL or builder config
    // (console/env) applies to the next build without a restart. The backend
    // is re-selected per build; the registry URL is re-read per use.
    builder: () => createImageBuilder(),
    registryUrl: () => registryUrl(),
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
    tasks,
    terminal,
    images,
    idle,
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
  tasks: AgentTaskService;
  terminal: TerminalService;
  idle: IdleReaper;
  registerHarnessDispatch: typeof registerHarnessDispatch;
}

/** Bootstrap hook: call once after `createServerContainer()`. */
export async function wireBuiltinHarnesses(container: ServerContainer) {
  await registerBuiltinHarnesses(container);
}

/**
 * Resolve one toolbox to a `ToolsetRef`, or `undefined` if it can't be
 * resolved this spawn. Shared by the auto-inject and explicit-selector tiers
 * of `resolveSpawnToolboxes` — both need the same pinned-fast-path → build →
 * lazy-record → log-and-skip sequence.
 *
 * Pinned (docs/toolbox-versions.md §2): resolve straight to the saved ref,
 * skipping `buildToolset` entirely — no build, no content-hash lookup, just
 * the pointer. A dangling pin falls back to the recipe build (same
 * "never fail the whole spawn" resilience as the build path).
 *
 * Each build uses a STABLE registry name keyed on the immutable toolbox id
 * (`toolboxArtifactName`), so renaming an org or moving the toolbox to
 * another org never churns artifacts. `buildToolset` is content-hash
 * idempotent + inflight-deduped, so resolving fresh on every spawn (no memo
 * cache, R5) is cheap after the first build. A single toolbox's build
 * failure is logged and skipped — never fails the whole spawn.
 */
async function resolveToolboxToRef(
  container: ServerContainer,
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
      name: toolboxArtifactName(config),
      source: config.source,
      build: config.build,
      paths: config.paths,
    });
    await recordBuiltVersionLazily(container, config, ref);
    return { ref };
  } catch (err) {
    log.error(
      { err, orgId: config.orgId, slug: config.slug },
      "toolbox build failed; skipping for this spawn",
    );
    return undefined;
  }
}

/** What a spawn applies from its toolboxes. */
export interface SpawnToolboxes {
  /** Built or pinned toolsets to materialize (toolboxes with `paths`). */
  refs: ToolsetRef[];
  /** Every toolbox applied, in precedence order (later wins): the org's
   * auto-inject ones oldest-first, the picked selectors, then the toolboxes
   * behind explicit `spec.toolsets` refs. Drives harness, files and surface. */
  applied: ToolboxConfig[];
}

/**
 * Resolve the toolboxes a spawn applies (entities-toolbox.md §5): the spawn
 * org's auto-inject toolboxes, then the explicitly picked `tb/<id>`
 * selectors. `orgId` is optional (`undefined` skips the org tier — spawn
 * bare, never throw); a selected toolbox must belong to an org the caller is
 * in. A toolbox without `paths` (process-only, files-only) produces no
 * toolset but is still applied. A single toolbox's build failure is logged
 * and skipped, never fails the spawn.
 */
export async function resolveSpawnToolboxes(
  container: ServerContainer,
  input: {
    orgId?: string;
    userId: string;
    selectors: string[];
    toolsets: ToolsetRef[];
  },
): Promise<SpawnToolboxes> {
  const { toolboxService } = container.control;
  const { orgMemberService } = container.control;
  const autoInject = input.orgId
    ? toolboxService.listAutoInject(input.orgId)
    : [];
  const selected = input.selectors.flatMap((selector) => {
    const config = toolboxForRef(container, selector);
    if (!config) return [];
    orgMemberService.requireMembership(config.orgId, input.userId);
    return [config];
  });
  // The caller's explicit toolsets are already materialized by the spec; they
  // only contribute their toolbox's harness/files/surface, and only when the
  // caller belongs to that toolbox's org.
  const explicit = input.toolsets.flatMap(({ ref }) => {
    const config = toolboxForRef(container, ref);
    const member =
      config && orgMemberService.getMembership(config.orgId, input.userId);
    return config && member ? [config] : [];
  });

  const applied = [
    ...new Map(
      [...autoInject, ...selected, ...explicit].map((c) => [c.id, c]),
    ).values(),
  ];
  // Resolve everything concurrently — builds are content-hash idempotent and
  // inflight-deduped, so parallel cold builds each get their own throwaway
  // pod instead of queuing. `Promise.all` preserves position.
  const refs = await Promise.all(
    [...autoInject, ...selected]
      .filter((config) => config.paths.length > 0)
      .map((config) => resolveToolboxToRef(container, config)),
  );
  return { refs: refs.filter((ref) => ref !== undefined), applied };
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
export async function recordBuiltVersionLazily(
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

/** The toolbox id in a toolbox artifact ref or selector (`tb/<id>`, with or
 * without a registry prefix or `@digest`). Artifacts built before artifact
 * names were keyed on the id (`tb/<ownerType>/<ownerId>/<slug>`) don't match:
 * their version rows keep resolving through the stored `ref`, they just can't
 * be mapped back to a toolbox from the name alone. */
function toolboxIdOfRef(ref: string): string | undefined {
  return ref.match(/(?:^|\/)tb\/([^/@]+)(?:@|$)/)?.[1];
}

/** The toolbox behind a `tb/<id>` selector, artifact ref or registry name. */
export function toolboxForRef(
  container: ServerContainer,
  ref: string,
): ToolboxConfig | undefined {
  const id = toolboxIdOfRef(ref);
  return id ? container.control.toolboxService.find(id) : undefined;
}

/**
 * The harness the toolbox behind a single toolset name declares, if any.
 * Viewer-independent (unlike the compose map). Used to enrich the global
 * toolset list so the compose surface can tag any toolset.
 */
export function harnessForToolset(
  container: ServerContainer,
  name: string,
): string | undefined {
  return toolboxForRef(container, name)?.harness;
}

/** The winning harness a spawn's toolboxes declare (entities-toolbox.md): the
 * last applied toolbox that names one. Undefined when none does. */
export function toolboxHarness(applied: ToolboxConfig[]): string | undefined {
  return [...applied].reverse().find((config) => config.harness)?.harness;
}

/**
 * The spec with the applied toolboxes' files merged in (keyed by path: a later
 * toolbox wins, and the spec's own file wins over every toolbox). Runs BEFORE
 * enrichment so a toolbox file's `$secret` content resolves there.
 */
export function withToolboxFiles(
  spec: SandboxSpec,
  applied: ToolboxConfig[],
): SandboxSpec {
  const files = mergeSpecs(
    ...applied.map((config) => ({ files: config.files })),
    { files: spec.files },
  ).files;
  return files ? { ...spec, files } : spec;
}

/**
 * Collect the processes + ports every applied toolbox contributes
 * (entities-toolbox.md). A toolbox is not just files: it can carry a tool's
 * *runtime surface* — vscode's `code-server` process + its port, or the
 * browser stack's kasmvnc/openbox/chromium (binaries baked into the
 * dev-browser base image, so no `build`/`paths`; a browserless base like
 * dev-base won't have them). Returns a spec fragment the caller merges in.
 */
export function toolboxSurface(
  applied: ToolboxConfig[],
): Required<RuntimeSurface> {
  const processes: ProcessEntry[] = [];
  const ports: PortEntry[] = [];
  for (const config of applied) {
    if (config.processes) processes.push(...config.processes);
    if (config.ports) ports.push(...config.ports);
  }
  return { processes, ports };
}
