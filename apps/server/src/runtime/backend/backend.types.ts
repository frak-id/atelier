/**
 * The runtime's backend port. `RuntimeService` keeps the backend-neutral logic
 * (op-locks, content-hash dedup, phase ordering, GC guards, snapshot/toolset
 * bookkeeping); every leaf container/disk/URL call goes through this seam, so a
 * Docker or local-process backend can replace the Kubernetes one without
 * touching policy. See docs/proposals/portable-runtime-backends.md §3.
 */
import type { PortEntry, SandboxSpec } from "@atelier/spec";
import type { AgentClient } from "../agent/index.ts";
import type { BootInput, BootOutput } from "../boot.ts";

export interface SandboxUrl {
  name: string;
  url: string;
}

/**
 * Where the guest agent is reachable from the server. The Kubernetes backend
 * yields the pod IP + fixed ports; a Docker backend yields `127.0.0.1` + the
 * per-container published host ports (proposal §4.4). `AgentClient` dials this
 * instead of resolving a pod IP itself — the endpoint-resolution seam that was
 * deferred out of step 1 (implementation log, oracle Q2).
 */
export interface AgentEndpoint {
  /** Client-reachable host (pod IP, or 127.0.0.1 for Docker). */
  host: string;
  /** HTTP control-plane port. */
  agentPort: number;
  /** WS attach-bridge port. */
  attachPort: number;
  /** WS terminal-multiplexer port. */
  terminalPort: number;
}

/**
 * Storage plane: disk snapshot / clone / existence. Varies independently of
 * the sandbox orchestrator (CSI VolumeSnapshot today; btrfs/zfs/reflink/copy
 * or an OCI-tar materialization later — see proposal §5-6).
 */
export interface VolumeBackend {
  /**
   * Snapshot `pvcName` into `ref` and wait until it is ready. Idempotent on
   * `ref`: a forced rebuild can resolve to a name that already exists, so any
   * prior snapshot of that name is replaced instead of colliding.
   *
   * NOTE (proposal §5, step 3): this returns `void` today because the ref is
   * computed by the caller and passed in. An OCI-tar backend will need to
   * return what it produced (a ref/locator) — expect this signature to grow.
   */
  snapshot(
    pvcName: string,
    ref: string,
    labels: Record<string, string>,
    annotations?: Record<string, string>,
  ): Promise<void>;
  /** Best-effort delete of a snapshot artifact (an already-gone one is fine). */
  deleteSnapshot(ref: string): Promise<void>;
  /** Does the sandbox's live disk still exist? (`resume`'s PVC-reuse check). */
  volumeExists(pvcName: string): Promise<boolean>;
}

/**
 * Orchestration plane: create/destroy compute, expose ports, resolve URLs.
 * Holds a `VolumeBackend` because storage varies on its own axis.
 */
export interface SandboxBackend {
  readonly volumes: VolumeBackend;
  /** Full boot: create disk + compute + network, then wait for the agent. */
  boot(
    id: string,
    spec: SandboxSpec,
    input: BootInput,
    agent: AgentClient,
  ): Promise<BootOutput>;
  /** Delete compute + network, keep the disk (pause / resume-rollback). */
  deleteRestartable(id: string): Promise<void>;
  /** Full label-sweep teardown; returns whether the sweep fully succeeded. */
  cleanup(id: string): Promise<boolean>;
  /** Is the sandbox's compute (pod) present? (startup reconciliation). */
  computeExists(id: string): Promise<boolean>;
  /**
   * Live-add a public port after boot (mechanism only — the `public` decision
   * stays with the caller). No-op-safe to call once per newly public port.
   */
  exposePort(id: string, port: PortEntry): Promise<void>;
  /**
   * Read-side public URLs (port URLs + the ssh entry) — the backend-varying
   * host/scheme shaping. The readiness overlay (which processes gate a URL,
   * live-vs-declared correlation) is backend-neutral policy and stays in
   * `RuntimeService`.
   */
  urls(id: string, spec: SandboxSpec): SandboxUrl[];

  /**
   * Resolve where the sandbox's agent is reachable, or `null` when compute is
   * not ready yet (pod unscheduled / no IP; container still starting) so a
   * poller can retry. `AgentClient` owns caching + the ws/http scheme; this is
   * the backend-varying host/port shaping only.
   */
  resolveAgentEndpoint(id: string): Promise<AgentEndpoint | null>;
}
