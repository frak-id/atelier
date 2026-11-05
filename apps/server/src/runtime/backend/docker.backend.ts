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
import { ValidationError } from "../../shared/errors.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import { AGENT_ATTACH_PORT, type AgentClient } from "../agent/index.ts";
import type { BootInput, BootOutput } from "../boot.ts";
import { provisionAgent } from "../boot-agent.ts";
import { resourceName } from "../resource-name.ts";
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
    return resourceName(id);
  }

  /** Container ports to publish: infra (agent/attach/terminal/ssh) + every
   * spec-declared port, deduped. Each is published on a dynamic loopback host
   * port (`-p 127.0.0.1::<cport>`) so many sandboxes coexist without clashing
   * and nothing is exposed off-host. */
  private publishedPorts(spec: SandboxSpec): number[] {
    const ports = new Set<number>([AGENT_PORT, AGENT_ATTACH_PORT, SSH_PORT]);
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
    // The agent refuses calls without this token and the record doesn't exist
    // yet, so hand it to the client before the first agent call.
    agent.setToken(id, agentPassword);

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
      // shared verbatim with the k8s boot. Local mode runs no SSH gateway;
      // `sshHostKeys` is still returned so the record carries it.
      const { podIp, sshHostKeys } = await provisionAgent(
        id,
        spec,
        input,
        agent,
      );

      return {
        podName: containerName,
        pvcName,
        agentPassword,
        podIp,
        sshHostKeys,
      };
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
    await this.removeContainer(id);
  }

  /** `docker rm -f` the sandbox's container; one that is already gone is
   * fine, any other failure throws. */
  private async removeContainer(id: string): Promise<void> {
    const res = await this.docker(["rm", "-f", this.containerName(id)]);
    if (res.code !== 0 && !res.stderr.includes("No such container")) {
      throw new Error(
        `docker rm ${this.containerName(id)} failed: ${res.stderr}`,
      );
    }
  }

  /** Remove the container, the live volume and every snapshot volume the
   * sandbox owns. Keeps going past a failed step so one leak doesn't hide
   * the others; false when any step failed (destroy then keeps the record). */
  async cleanup(id: string): Promise<boolean> {
    const steps = [
      () => this.removeContainer(id),
      () => this.local.deleteVolume(this.containerName(id)),
      () => this.local.deleteSnapshotsOwnedBy(id),
    ];
    let clean = true;
    for (const step of steps) {
      try {
        await step();
      } catch (error) {
        clean = false;
        log.warn({ id, error }, "Docker cleanup incomplete");
      }
    }
    return clean;
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
    // Every port the spec declared (public or not) is published at boot, so
    // exposing one of those is already done; any other needs a container
    // recreate, so say no instead of recording a port that has no route.
    if ((await this.hostPort(id, port.port)) != null) return;
    throw new ValidationError(
      `Cannot expose port ${port.port} (${port.name}) on the running Docker ` +
        `sandbox ${id}: declare it in the spec at create time (live port ` +
        "publishing needs a container recreate).",
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
    const [agentPort, attachPort] = await Promise.all([
      this.hostPort(id, AGENT_PORT),
      this.hostPort(id, AGENT_ATTACH_PORT),
    ]);
    if (agentPort == null || attachPort == null) {
      return null;
    }
    return { host: "127.0.0.1", agentPort, attachPort };
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
