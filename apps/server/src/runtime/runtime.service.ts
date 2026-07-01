/**
 * `RuntimeService` — THE SEAM. `runtime.create(spec)` as a function signature
 * that policy code cannot reach past (atelier-v2 §3). Mechanism only: it knows
 * how to boot/pause/resume/destroy, push files/env, supervise processes,
 * expose ports, run hooks, exec, and snapshot. It never parses ACP, reads a
 * harness config, or models "MCP". It imports nothing from control/ or
 * sessions/.
 */
import { createHash } from "node:crypto";
import {
  type AddPortRequest,
  type AddProcessRequest,
  type CreateSandboxResponse,
  type ExecRequest,
  isSecretRef,
  type PatchEnvRequest,
  type PatchFilesRequest,
  type PortEntry,
  type PrebuildSpec,
  type ProcessStatus,
  type ResumeRequest,
  type SandboxSpec,
  type SandboxState,
  type SnapshotRef,
} from "@atelier/spec";
import { NotFoundError, ValidationError } from "../shared/errors.ts";
import { config } from "../shared/lib/config.ts";
import { safeNanoid } from "../shared/lib/id.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import { AgentClient } from "./agent/index.ts";
import { bootSandbox, deleteRestartableResources } from "./boot.ts";
import { cleanupSandboxResources } from "./cleanup.ts";
import { buildVolumeSnapshot, kubeClient } from "./kube/index.ts";
import { buildPortIngresses, buildPortUrls, sshUrl } from "./ports.ts";
import { ImageRegistryService } from "./registry/index.ts";
import {
  InMemorySandboxStore,
  InMemorySnapshotStore,
  type SandboxRecord,
  type SandboxStore,
  type SnapshotStore,
} from "./store.ts";

const log = createChildLogger("runtime");

export interface RuntimeCreateOptions {
  /** Externally-chosen sandbox id (control assigns it). Defaults to a nanoid. */
  id?: string;
  /** SSH public keys authorized on the pipe — content resolved by the caller. */
  authorizedKeys?: string[];
}

export interface RuntimeDeps {
  agent?: AgentClient;
  sandboxes?: SandboxStore;
  snapshots?: SnapshotStore;
}

export class RuntimeService {
  private readonly agent: AgentClient;
  private readonly sandboxes: SandboxStore;
  private readonly snapshots: SnapshotStore;

  constructor(deps: RuntimeDeps = {}) {
    this.agent = deps.agent ?? new AgentClient();
    this.sandboxes = deps.sandboxes ?? new InMemorySandboxStore();
    this.snapshots = deps.snapshots ?? new InMemorySnapshotStore();
  }

  // ── prebuild ───────────────────────────────────────────────────────────

  /**
   * Chained, content-addressed prebuild. Idempotent: keyed by content hash;
   * a hit returns instantly. Runtime content never enters the key.
   */
  async prebuild(spec: PrebuildSpec): Promise<SnapshotRef> {
    const hash = hashPrebuild(spec);
    const existing = this.snapshots.getByHash(hash);
    if (existing) {
      return { ref: existing.ref, hash, parent: existing.parent };
    }

    const parentRef =
      "snapshot" in spec.source ? spec.source.snapshot : undefined;
    const image = await this.resolveImage(spec.source);
    // NOTE: running build[]/repos in a temp pod then snapshotting the PVC is
    // the mechanism to wire in milestone 4. Phase 0 records the keyed snapshot
    // so chaining + idempotency are exercised end-to-end.
    const ref = `snap_${hash.slice(0, 12)}`;
    this.snapshots.put({
      hash,
      ref,
      image,
      parent: parentRef,
      createdAt: new Date().toISOString(),
    });
    log.info({ ref, hash, parent: parentRef }, "prebuild snapshot recorded");
    return { ref, hash, parent: parentRef };
  }

  // ── create ─────────────────────────────────────────────────────────────

  async create(
    spec: SandboxSpec,
    options: RuntimeCreateOptions = {},
  ): Promise<CreateSandboxResponse> {
    rejectUnresolvedSecrets(spec);
    const id = options.id ?? safeNanoid();
    const { image, snapshotName } = await this.resolveSource(spec.source);

    const now = new Date().toISOString();
    const record: SandboxRecord = {
      id,
      spec,
      status: "creating",
      generated: {},
      metadata: spec.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.sandboxes.create(record);

    try {
      const boot = await bootSandbox(
        id,
        spec,
        { image, snapshotName, authorizedKeys: options.authorizedKeys },
        this.agent,
      );
      await this.runHooks(id, spec.hooks?.postCreate);
      await this.runHooks(id, spec.hooks?.postStart);

      this.sandboxes.update(id, {
        status: "running",
        podName: boot.podName,
        pvcName: boot.pvcName,
        generated: { agentPassword: boot.agentPassword, podIp: boot.podIp },
      });

      return {
        id,
        urls: this.urlsFor(id, spec),
        generated: { agentPassword: boot.agentPassword, podIp: boot.podIp },
      };
    } catch (error) {
      this.sandboxes.update(id, { status: "error" });
      throw error;
    }
  }

  // ── read ───────────────────────────────────────────────────────────────

  async get(id: string): Promise<SandboxState> {
    const record = this.require(id);
    return {
      id,
      status: record.status,
      urls: this.urlsFor(id, record.spec),
      processes: await this.processStatuses(record),
      generated: record.generated,
      metadata: record.metadata,
      annotations: record.spec.annotations,
    };
  }

  // ── pause / resume ─────────────────────────────────────────────────────

  /** Snapshot the disk, release compute (delete pod, keep PVC). */
  async pause(id: string): Promise<SnapshotRef> {
    this.require(id);
    const ref = await this.snapshot(id);
    this.agent.invalidatePodIp(id);
    await deleteRestartableResources(id);
    this.sandboxes.update(id, { status: "paused" });
    log.info({ id, ref: ref.ref }, "sandbox paused");
    return ref;
  }

  /** Boot from the pause snapshot, injecting rotated files/env, run onResume. */
  async resume(id: string, req: ResumeRequest = {}): Promise<SandboxState> {
    const record = this.require(id);
    const spec = mergeResume(record.spec, req);
    const { image, snapshotName } = await this.resolveSource(spec.source);

    const boot = await bootSandbox(
      id,
      spec,
      { image, snapshotName },
      this.agent,
    );
    await this.runHooks(id, spec.hooks?.onResume);
    this.sandboxes.update(id, {
      spec,
      status: "running",
      generated: { agentPassword: boot.agentPassword, podIp: boot.podIp },
    });
    return this.get(id);
  }

  // ── destroy ────────────────────────────────────────────────────────────

  async destroy(id: string): Promise<void> {
    this.require(id);
    this.agent.invalidatePodIp(id);
    await cleanupSandboxResources(id, { podName: `sandbox-${id}` });
    this.sandboxes.delete(id);
    log.info({ id }, "sandbox destroyed");
  }

  // ── live mutations ─────────────────────────────────────────────────────

  async patchFiles(id: string, files: PatchFilesRequest): Promise<void> {
    this.require(id);
    await this.agent.writeFiles(
      id,
      files.map((f) => ({
        path: f.path,
        content: f.content,
        mode: f.mode,
        owner: f.owner as "dev" | "root" | undefined,
      })),
    );
  }

  /**
   * Re-export env to future process spawns and fire the `envChanged` hook.
   * Does NOT mutate a running process's environment (stated honestly,
   * atelier-v2 §2 "Runtime API").
   */
  async patchEnv(id: string, env: PatchEnvRequest): Promise<void> {
    const record = this.require(id);
    const nextEnv = { ...(record.spec.env ?? {}), ...env };
    this.sandboxes.update(id, { spec: { ...record.spec, env: nextEnv } });
    await this.runHooks(id, record.spec.hooks?.envChanged);
  }

  async exec(id: string, req: ExecRequest) {
    this.require(id);
    return this.agent.exec(id, req.command, {
      timeout: req.timeoutMs,
      workdir: req.cwd,
    });
  }

  async processAction(
    id: string,
    name: string,
    action: "start" | "stop",
  ): Promise<void> {
    this.require(id);
    if (action === "start") await this.agent.serviceStart(id, name);
    else await this.agent.serviceStop(id, name);
  }

  async processLogs(id: string, name: string) {
    this.require(id);
    return this.agent.serviceLogs(id, name, 0, 10_000);
  }

  /**
   * Register an ad-hoc supervised process after boot. Updates the stored spec
   * immediately; best-effort starts it now unless `lazy`. NOTE: the v1 agent
   * has no generic "register + supervise a new process" endpoint distinct
   * from boot-time services — full dynamic supervision is v2 agent-line work
   * (atelier-v2 §6 milestone 1). This records intent and starts it via exec.
   */
  async addProcess(id: string, req: AddProcessRequest): Promise<void> {
    const record = this.require(id);
    const spec: SandboxSpec = {
      ...record.spec,
      processes: [...(record.spec.processes ?? []), req],
    };
    this.sandboxes.update(id, { spec });
    if (!req.lazy) {
      await this.agent.exec(id, req.command, { workdir: req.cwd });
    }
  }

  /** Expose a port after boot — creates the ingress now, real mechanism. */
  async addPort(id: string, req: AddPortRequest): Promise<void> {
    const record = this.require(id);
    const portEntry: PortEntry = {
      name: req.name,
      port: req.port,
      public: req.public ?? true,
    };
    const spec: SandboxSpec = {
      ...record.spec,
      ports: [...(record.spec.ports ?? []), portEntry],
    };
    this.sandboxes.update(id, { spec });
    if (portEntry.public) {
      for (const resource of buildPortIngresses(id, [portEntry])) {
        await kubeClient.createResource(resource);
      }
    }
  }

  /**
   * Resolve a WS attach URL for a process's stdio bridge. NOTE: today's agent
   * has one bridge model (spawn-and-relay, `acpSessionCreate`), so this
   * approximates generic attach by reusing it — a faithful "attach to an
   * already-running process's stdio" needs the unified bridge from the v2
   * agent milestone. `pty` processes aren't wired yet (todo, same milestone).
   */
  async attach(id: string, processName: string): Promise<{ url: string }> {
    const record = this.require(id);
    const proc = record.spec.processes?.find((p) => p.name === processName);
    if (!proc) throw new NotFoundError("Process", processName);
    if (proc.stdio !== "bridge") {
      throw new ValidationError(
        `Process "${processName}" has no stdio bridge configured`,
      );
    }
    const bridge = await this.agent.acpSessionCreate(id, {
      command: proc.command,
      workdir: proc.cwd,
      user: "dev",
    });
    const url = await this.agent.acpWebSocketUrl(
      id,
      bridge.id,
      config.ports.acp,
    );
    return { url };
  }

  // ── snapshot ───────────────────────────────────────────────────────────

  /** Promote the current disk → snapshotRef. */
  async snapshot(id: string): Promise<SnapshotRef> {
    const record = this.require(id);
    const pvcName = record.pvcName ?? `sandbox-${id}`;
    const hash = createHash("sha256")
      .update(`${id}:${Date.now()}`)
      .digest("hex");
    const ref = `snap_${hash.slice(0, 12)}`;
    const { image } = await this.resolveSource(record.spec.source);

    await kubeClient.createResource(
      buildVolumeSnapshot({
        name: ref,
        pvcName,
        labels: { "atelier.dev/sandbox": id },
      }),
    );
    await kubeClient.waitForVolumeSnapshotReady(ref, { timeout: 120_000 });

    this.snapshots.put({
      hash,
      ref,
      image,
      createdAt: new Date().toISOString(),
    });
    return { ref, hash };
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private require(id: string): SandboxRecord {
    const record = this.sandboxes.get(id);
    if (!record) throw new NotFoundError("Sandbox", id);
    return record;
  }

  private async resolveSource(
    source: SandboxSpec["source"],
  ): Promise<{ image: string; snapshotName?: string }> {
    if ("snapshot" in source) {
      const snap =
        this.snapshots.get(source.snapshot) ??
        this.snapshots.getByHash(source.snapshot);
      if (!snap) throw new NotFoundError("Snapshot", source.snapshot);
      return { image: snap.image, snapshotName: snap.ref };
    }
    return { image: await this.resolveImage(source) };
  }

  private resolveImage(source: SandboxSpec["source"]): Promise<string> {
    if ("snapshot" in source) {
      const snap = this.snapshots.get(source.snapshot);
      return Promise.resolve(snap?.image ?? source.snapshot);
    }
    // A fully-qualified ref (registry/host or digest) is used verbatim;
    // a bare name is resolved against the configured registry.
    if (source.image.includes("/") || source.image.includes("@")) {
      return Promise.resolve(source.image);
    }
    return ImageRegistryService.resolveImageReference(source.image);
  }

  private urlsFor(id: string, spec: SandboxSpec) {
    return [...buildPortUrls(id, spec.ports), { name: "ssh", url: sshUrl(id) }];
  }

  private async processStatuses(
    record: SandboxRecord,
  ): Promise<ProcessStatus[]> {
    if (record.status !== "running") return [];
    try {
      const { services } = await this.agent.serviceList(record.id);
      return services.map((s) => ({
        name: s.name,
        running: s.status === "running",
        primary: record.spec.processes?.find((p) => p.name === s.name)?.primary,
      }));
    } catch {
      return [];
    }
  }

  private async runHooks(id: string, hooks?: string[]): Promise<void> {
    for (const cmd of hooks ?? []) {
      await this.agent.exec(id, cmd, { timeout: 120_000 });
    }
  }
}

// ── module helpers ─────────────────────────────────────────────────────────

function rejectUnresolvedSecrets(spec: SandboxSpec): void {
  const offenders: string[] = [];
  for (const [k, v] of Object.entries(spec.env ?? {})) {
    if (isSecretRef(v)) offenders.push(`env.${k}`);
  }
  for (const f of spec.files ?? []) {
    if (isSecretRef(f.content)) offenders.push(`files[${f.path}]`);
  }
  for (const p of spec.processes ?? []) {
    for (const [k, v] of Object.entries(p.env ?? {})) {
      if (isSecretRef(v)) offenders.push(`processes[${p.name}].env.${k}`);
    }
  }
  if (offenders.length > 0) {
    throw new ValidationError(
      `Spec contains unresolved secret references: ${offenders.join(", ")}. ` +
        "Secrets must be resolved by control before crossing the seam.",
    );
  }
}

function mergeResume(spec: SandboxSpec, req: ResumeRequest): SandboxSpec {
  return {
    ...spec,
    files: req.files ? [...(spec.files ?? []), ...req.files] : spec.files,
    env: req.env ? { ...(spec.env ?? {}), ...req.env } : spec.env,
  };
}

function hashPrebuild(spec: PrebuildSpec): string {
  const keyed = {
    source: spec.source,
    files: spec.files ?? [],
    build: spec.build ?? [],
    repos: spec.repos ?? [],
  };
  return createHash("sha256").update(JSON.stringify(keyed)).digest("hex");
}
