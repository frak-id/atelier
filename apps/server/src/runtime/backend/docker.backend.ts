/**
 * The Docker implementation of the runtime backend port — the self-host payoff
 * (proposal §8 step 5). A sandbox is a `docker run` container: `/data` is a
 * host-directory volume (see {@link LocalVolumeBackend}), each infra + tool
 * port is published on a dynamic loopback host port, and the agent is dialed at
 * `127.0.0.1:<mapped>` via {@link resolveAgentEndpoint}. Isolation is the
 * container boundary, not a VM — acceptable for local/laptop use (proposal §2,
 * trust-boundary follow-up).
 *
 * Requires a Linux Docker daemon (native, or the Linux VM of Docker Desktop /
 * OrbStack / Lima). The container runs `--privileged --user 0` and the sandbox
 * image's `/etc/sandbox/sandbox-boot.sh` entrypoint, exactly as the Kubernetes
 * pod does, so the guest agent's overlay/loop-mount toolset model is unchanged.
 */

import type { PortEntry, SandboxSpec } from "@atelier/spec";
import { customAlphabet } from "nanoid";
import { createChildLogger } from "../../shared/lib/logger.ts";
import type { AgentClient } from "../agent/index.ts";
import type { BootInput, BootOutput } from "../boot.ts";
import { provisionAgent } from "../boot-agent.ts";
import type {
  AgentEndpoint,
  SandboxBackend,
  SandboxUrl,
  VolumeBackend,
} from "./backend.types.ts";
import { docker } from "./docker-cli.ts";
import { DockerVolumeBackend } from "./docker-volume.backend.ts";

const log = createChildLogger("runtime-backend-docker");

const generatePassword = customAlphabet(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
);

/** Container port the guest agent's HTTP control plane listens on. */
const AGENT_PORT = 9998;
/** Container port the WS attach bridge listens on. */
const ATTACH_PORT = 9997;
/** Container port the WS terminal multiplexer listens on. */
const TERMINAL_PORT = 7681;
/** Container SSH port. */
const SSH_PORT = 22;

const DEFAULT_BOOT_SCRIPT = "/etc/sandbox/sandbox-boot.sh";

export interface DockerBackendOptions {
  volumes?: DockerVolumeBackend;
  /** Entrypoint to run (matches the k8s `command` override). `false` uses the
   * image's own entrypoint — for a bare agent image that has no boot script. */
  bootScript?: string | false;
  dockerBin?: string;
}

export class DockerBackend implements SandboxBackend {
  readonly volumes: VolumeBackend;
  private readonly local: DockerVolumeBackend;
  private readonly bootScript: string | false;
  private readonly dockerBin: string;

  constructor(options: DockerBackendOptions = {}) {
    this.local = options.volumes ?? new DockerVolumeBackend();
    this.volumes = this.local;
    this.bootScript = options.bootScript ?? DEFAULT_BOOT_SCRIPT;
    this.dockerBin = options.dockerBin ?? "docker";
  }

  private docker(args: string[]) {
    return docker(args, this.dockerBin);
  }

  private containerName(id: string): string {
    return `sandbox-${id}`;
  }

  /** Container ports to publish: infra (agent/attach/terminal/ssh) + every
   * spec-declared port, deduped. Each is published on a dynamic loopback host
   * port (`-p 127.0.0.1::<cport>`) so many sandboxes coexist without clashing
   * and nothing is exposed off-host. */
  private publishedPorts(spec: SandboxSpec): number[] {
    const ports = new Set<number>([
      AGENT_PORT,
      ATTACH_PORT,
      TERMINAL_PORT,
      SSH_PORT,
    ]);
    for (const p of spec.ports ?? []) ports.add(p.port);
    return [...ports];
  }

  async boot(
    id: string,
    spec: SandboxSpec,
    input: BootInput,
    agent: AgentClient,
  ): Promise<BootOutput> {
    const containerName = this.containerName(id);
    const pvcName = containerName;
    const agentPassword = generatePassword(32);

    try {
      // Reuse (resume) keeps the existing dir; a snapshot boot clones it; a
      // fresh boot creates it empty — mirrors the k8s PVC dataSource/reuse.
      await this.local.ensureVolume(
        pvcName,
        input.reusePvc ? undefined : input.snapshotName,
      );

      const runArgs = ["run", "-d", "--name", containerName];
      // --privileged + --user 0: the agent loop-mounts squashfs/erofs toolset
      // blobs and assembles the /home/dev overlay from inside the container —
      // the Docker analogue of the pod's runAsUser 0 + CAP_SYS_ADMIN.
      runArgs.push("--privileged", "--user", "0");
      runArgs.push("-v", `${this.local.volumeName(pvcName)}:/data`);
      runArgs.push("-e", `SANDBOX_ID=${id}`);
      runArgs.push("-e", `AGENT_PASSWORD=${agentPassword}`);
      for (const cport of this.publishedPorts(spec)) {
        runArgs.push("-p", `127.0.0.1::${cport}`);
      }
      if (this.bootScript !== false) {
        runArgs.push("--entrypoint", this.bootScript);
      }
      runArgs.push(input.image);

      const run = await this.docker(runArgs);
      if (run.code !== 0) {
        throw new Error(
          `docker run failed for ${containerName}: ${run.stderr}`,
        );
      }

      // Backend-neutral tail (wait for agent -> materialize -> config -> files),
      // shared verbatim with the k8s boot.
      const podIp = await provisionAgent(id, spec, input, agent);

      return { podName: containerName, pvcName, agentPassword, podIp };
    } catch (error) {
      log.error(
        {
          id,
          error: error instanceof Error ? error.message : String(error),
        },
        "Docker boot failed, cleaning up",
      );
      if (input.preserveDisk) await this.deleteRestartable(id);
      else await this.cleanup(id);
      throw error;
    }
  }

  async deleteRestartable(id: string): Promise<void> {
    // Remove the container, keep the volume dir (pause / resume-rollback).
    await this.docker(["rm", "-f", this.containerName(id)]);
  }

  async cleanup(id: string): Promise<boolean> {
    try {
      await this.docker(["rm", "-f", this.containerName(id)]);
      await this.local.deleteVolume(this.containerName(id));
      return true;
    } catch (error) {
      log.warn({ id, error }, "Docker cleanup incomplete");
      return false;
    }
  }

  async computeExists(id: string): Promise<boolean> {
    const res = await this.docker([
      "inspect",
      "-f",
      "{{.State.Running}}",
      this.containerName(id),
    ]);
    return res.code === 0 && res.stdout.trim() === "true";
  }

  async exposePort(id: string, port: PortEntry): Promise<void> {
    // Docker cannot publish a new host port on an already-running container.
    // Ports declared in the spec are published at boot; a truly live-added
    // public port needs a container recreate. Surface it rather than failing
    // silently (see the implementation log's step-5 limitations).
    log.warn(
      { id, port: port.name },
      "exposePort is a no-op on the Docker backend; declare the port in the " +
        "spec at boot (live port publish needs a container recreate)",
    );
  }

  async urls(id: string, spec: SandboxSpec): Promise<SandboxUrl[]> {
    const urls: SandboxUrl[] = [];
    for (const port of spec.ports ?? []) {
      const host = await this.hostPort(id, port.port);
      if (host != null) {
        urls.push({ name: port.name, url: `http://127.0.0.1:${host}` });
      }
    }
    const ssh = await this.hostPort(id, SSH_PORT);
    if (ssh != null) {
      urls.push({ name: "ssh", url: `ssh://dev@127.0.0.1:${ssh}` });
    }
    return urls;
  }

  async resolveAgentEndpoint(id: string): Promise<AgentEndpoint | null> {
    const [agentPort, attachPort, terminalPort] = await Promise.all([
      this.hostPort(id, AGENT_PORT),
      this.hostPort(id, ATTACH_PORT),
      this.hostPort(id, TERMINAL_PORT),
    ]);
    if (agentPort == null || attachPort == null || terminalPort == null) {
      return null;
    }
    return { host: "127.0.0.1", agentPort, attachPort, terminalPort };
  }

  /** Resolve the dynamic host port a container port is published on, or `null`
   * when the container is gone / not yet mapped. Parses `docker port` output
   * (`<cport>/tcp -> 127.0.0.1:<hostport>`). */
  private async hostPort(
    id: string,
    containerPort: number,
  ): Promise<number | null> {
    const res = await this.docker([
      "port",
      this.containerName(id),
      `${containerPort}/tcp`,
    ]);
    if (res.code !== 0) return null;
    const match = res.stdout.match(/:(\d+)\s*$/m);
    return match ? Number(match[1]) : null;
  }
}
