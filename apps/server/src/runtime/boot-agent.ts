/**
 * Backend-neutral boot tail: once compute + network + volume exist and the
 * agent is reachable, every backend does the SAME provisioning — wait for the
 * agent, assemble the `/home/dev` overlay (materialize), push config, write
 * spec files. Extracted from the Kubernetes `bootSandbox` so the Docker backend
 * reuses it verbatim instead of duplicating (or drifting from) the sequence.
 */
import type { SandboxSpec } from "@atelier/spec";
import { type AgentClient, toFileWrites } from "./agent/index.ts";
import { specToAgentConfig } from "./agent-config.ts";
import type { BootInput } from "./boot.ts";

export interface ProvisionAgentResult {
  /** The reachable agent host (pod IP on k8s, 127.0.0.1 on Docker). */
  podIp: string;
  /**
   * The sandbox's sshd host public key line(s) (OpenSSH format), fetched
   * from `GET /ssh/host-keys` — SSH host-key pinning (ssh-gateway.ts /
   * ssh/proxy.ts). `null` when unavailable: an old agent image (404, no
   * such endpoint) or the boot script hasn't run `ssh-keygen -A` yet
   * (shouldn't happen — sandbox-boot.sh runs it before starting the agent —
   * but treated the same as "old agent" defensively). Callers fall back to
   * the unpinned strategy on `null`, never fail boot over it.
   */
  sshHostKeys: string[] | null;
}

/**
 * Wait for the agent to come alive, then run the ordered provisioning:
 *   1. materialize toolsets (assembles `/home/dev`, even with an empty list —
 *      see BootInput.toolsets), push config, and fetch the sshd host key(s),
 *      all concurrently;
 *   2. write spec files last, after the overlay is assembled.
 */
export async function provisionAgent(
  sandboxId: string,
  spec: SandboxSpec,
  input: BootInput,
  agent: AgentClient,
): Promise<ProvisionAgentResult> {
  const { ready, podIp } = await agent.waitForAgent(sandboxId, {
    timeout: 120_000,
  });
  if (!ready || !podIp) {
    throw new Error(`Sandbox ${sandboxId} agent did not become ready`);
  }

  // Three independent agent calls run concurrently: materialize the toolset
  // overlay (ALWAYS called, even empty — it's the only place `/home/dev` is
  // assembled), push config, and fetch the sshd host key(s) for pinning.
  // Materialize must land before files[] so spec-level files can override org
  // toolset config (last-wins layering).
  const [, , sshHostKeys] = await Promise.all([
    agent.materializeToolsets(sandboxId, input.toolsets ?? []),
    agent.putConfig(sandboxId, specToAgentConfig(sandboxId, spec)),
    agent.getSshHostKeys(sandboxId),
  ]);
  if (spec.files && spec.files.length > 0) {
    await agent.writeFiles(sandboxId, toFileWrites(spec.files));
  }

  return { podIp, sshHostKeys };
}
