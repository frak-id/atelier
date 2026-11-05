/**
 * Test doubles for driving `RuntimeService` without a cluster, a Docker
 * daemon or network git: an in-memory `SandboxBackend`, an `AgentClient`
 * whose calls answer canned results, and a fixed remote HEAD. Injected
 * through `RuntimeDeps` (`fakeRuntimeDeps()`); never used by production code.
 */
import type { PortEntry, SandboxSpec } from "@atelier/spec";
import type { AgentActivityReport } from "./activity.ts";
import type {
  AgentHealth,
  AgentProcessListResult,
  DevLogsResult,
  ExecResult,
  FileWrite,
  HookPhase,
  HookPhaseResult,
  WriteFilesResult,
} from "./agent/agent.types.ts";
import { AgentClient } from "./agent/index.ts";
import type { AgentConfig } from "./agent-config.ts";
import type {
  AgentEndpoint,
  SandboxBackend,
  SandboxUrl,
  VolumeBackend,
} from "./backend/index.ts";
import type { BootInput, BootOutput } from "./boot.ts";
import { provisionAgent } from "./boot-agent.ts";
import { buildPortUrls, sshUrl } from "./ports.ts";
import type { RuntimeDeps } from "./runtime.service.ts";

const FAKE_ENDPOINT: AgentEndpoint = {
  host: "10.42.0.99",
  agentPort: 9998,
  attachPort: 9997,
};

const FAKE_DIGEST = `sha256:${"0".repeat(64)}`;

/** An agent that is always up, runs nothing and reports success. */
export class FakeAgentClient extends AgentClient {
  constructor() {
    super(async () => FAKE_ENDPOINT);
  }

  override async health(_sandboxId: string): Promise<AgentHealth> {
    return { status: "ok", uptime: 0, configured: true, healthy: true };
  }

  override async activity(_sandboxId: string): Promise<AgentActivityReport> {
    const now = Date.now();
    return {
      nowMs: now,
      bootedAtMs: now,
      bucketSeconds: 60,
      network: "unavailable",
      files: "unavailable",
      cpu: "unavailable",
      buckets: [],
    };
  }

  override async getSshHostKeys(_sandboxId: string): Promise<string[]> {
    return ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeHostKey root@sandbox"];
  }

  override async putConfig(
    _sandboxId: string,
    _config: AgentConfig,
  ): Promise<void> {}

  override async runHook(
    _sandboxId: string,
    _phase: HookPhase,
  ): Promise<HookPhaseResult> {
    return { success: true, results: [] };
  }

  override async reconcile(_sandboxId: string): Promise<void> {}

  override async waitForAgent(_sandboxId: string): Promise<{
    ready: boolean;
    podIp: string | null;
  }> {
    return { ready: true, podIp: FAKE_ENDPOINT.host };
  }

  override async waitForPrimary(_sandboxId: string): Promise<boolean> {
    return true;
  }

  override async processList(
    _sandboxId: string,
  ): Promise<AgentProcessListResult> {
    return { processes: [] };
  }

  override async processStart(_sandboxId: string, _name: string) {}

  override async processStop(_sandboxId: string, _name: string) {}

  override async processLogs(
    _sandboxId: string,
    name: string,
  ): Promise<DevLogsResult> {
    return { name, content: "", nextOffset: 0 };
  }

  override async buildToolset(
    _sandboxId: string,
    _body: { target: string; paths: string[] },
  ): Promise<{ digest: string }> {
    return { digest: FAKE_DIGEST };
  }

  override async captureToolset(
    _sandboxId: string,
    _body: { target: string; paths: string[] },
  ): Promise<{ digest: string }> {
    return { digest: FAKE_DIGEST };
  }

  override async materializeToolsets(
    _sandboxId: string,
    _references: string[],
  ): Promise<void> {}

  override async writeFiles(
    _sandboxId: string,
    files: FileWrite[],
  ): Promise<WriteFilesResult> {
    return { results: files.map((f) => ({ path: f.path, success: true })) };
  }

  override async exec(
    _sandboxId: string,
    _command: string,
  ): Promise<ExecResult> {
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

/** Snapshots succeed instantly; no live disk survives a pause. */
class FakeVolumeBackend implements VolumeBackend {
  async snapshot(
    _pvcName: string,
    _ref: string,
    _labels: Record<string, string>,
  ): Promise<void> {}
  async deleteSnapshot(_ref: string): Promise<void> {}
  async volumeExists(_pvcName: string): Promise<boolean> {
    return false;
  }
}

/** Compute that boots instantly: only the backend-neutral agent tail
 * (`provisionAgent`) runs, against whatever agent the runtime passes. */
export class FakeBackend implements SandboxBackend {
  readonly volumes: VolumeBackend = new FakeVolumeBackend();

  async boot(
    id: string,
    spec: SandboxSpec,
    input: BootInput,
    agent: AgentClient,
  ): Promise<BootOutput> {
    const { podIp, sshHostKeys } = await provisionAgent(id, spec, input, agent);
    return {
      podName: `sandbox-${id}`,
      pvcName: `sandbox-${id}`,
      agentPassword: "test-password",
      podIp,
      sshHostKeys,
    };
  }

  async deleteRestartable(_id: string): Promise<void> {}

  async cleanup(_id: string): Promise<boolean> {
    return true;
  }

  async computeExists(_id: string): Promise<boolean> {
    return true;
  }

  async exposePort(_id: string, _port: PortEntry): Promise<void> {}

  async urls(id: string, spec: SandboxSpec): Promise<SandboxUrl[]> {
    return [...buildPortUrls(id, spec.ports), { name: "ssh", url: sshUrl(id) }];
  }

  async resolveAgentEndpoint(_id: string): Promise<AgentEndpoint | null> {
    return FAKE_ENDPOINT;
  }
}

/** Every repo's remote HEAD, as `git ls-remote` would report it. */
async function fakeRemoteHead(): Promise<string> {
  return "1".repeat(40);
}

/** The runtime's external edges, all faked. Spread into `RuntimeDeps` next
 * to the stores; override `backend` to observe or break a single call. */
export function fakeRuntimeDeps(): Required<
  Pick<RuntimeDeps, "agent" | "backend" | "remoteHead">
> {
  return {
    agent: new FakeAgentClient(),
    backend: new FakeBackend(),
    remoteHead: fakeRemoteHead,
  };
}
