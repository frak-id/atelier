/**
 * The server's top-level composition root — the only place all three modules
 * (runtime/control/sessions) are wired together. Manual-wiring convention
 * (no DI framework).
 */
import { createControlContainer } from "../control/index.ts";
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
  DrizzleTaskStore,
  SessionService,
  TerminalService,
} from "../sessions/index.ts";
import {
  bindRuntimeConfig,
  registryUrl,
} from "../shared/lib/runtime-config.ts";
import { SandboxOps } from "./app/sandbox-ops.ts";
import { ToolboxOps } from "./app/toolbox-ops.ts";
import { IdleReaper } from "./idle-reaper.ts";

export function createServerContainer() {
  const control = createControlContainer();
  // The runtime reads operational config (default image/size, agent image,
  // snapshot retention) through the console-editable config plane. Injected
  // here so runtime/ and shared/ never import control/.
  bindRuntimeConfig((key) => control.serverConfigService.get(key));
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
    // Stored specs keep their `$secret` refs and carry no credentials: every
    // boot resolves them here (control owns the secrets and the owner's token).
    resolveBootSpec: (spec) => control.resolveBootSpec(spec),
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
  // sessions with captured replies. Durable records, live state in memory; see task.service.ts.
  const tasks = new AgentTaskService({
    runtime,
    dispatch,
    store: new DrizzleTaskStore(),
  });
  const terminal = new TerminalService({ agent });
  // Idle auto-pause: the operator's rule (control) over the runtime's
  // activity clocks, blocked by ACP work in flight (sessions).
  const idle = new IdleReaper({
    runtime,
    jobs,
    dispatch,
    policy: control.idlePolicyService,
  });
  // The application layer under HTTP and MCP: the only place a request becomes
  // runtime + control + jobs calls (routes and tools stay thin).
  const toolboxOps = new ToolboxOps({ runtime, control, jobs });
  const sandboxOps = new SandboxOps({
    runtime,
    control,
    jobs,
    toolboxes: toolboxOps,
    idle,
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
    sandboxOps,
    toolboxOps,
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
  sandboxOps: SandboxOps;
  toolboxOps: ToolboxOps;
}
