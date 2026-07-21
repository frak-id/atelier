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

/**
 * Wait for the agent to come alive, then run the ordered provisioning:
 *   1. materialize toolsets (assembles `/home/dev`, even with an empty list —
 *      see BootInput.toolsets) and push config, concurrently;
 *   2. write spec files last, after the overlay is assembled.
 * Returns the reachable agent host (pod IP on k8s, 127.0.0.1 on Docker).
 */
export async function provisionAgent(
  sandboxId: string,
  spec: SandboxSpec,
  input: BootInput,
  agent: AgentClient,
): Promise<string> {
  const { ready, podIp } = await agent.waitForAgent(sandboxId, {
    timeout: 120_000,
  });
  if (!ready || !podIp) {
    throw new Error(`Sandbox ${sandboxId} agent did not become ready`);
  }

  // Two independent agent calls run concurrently: materialize the toolset
  // overlay (ALWAYS called, even empty — it's the only place `/home/dev` is
  // assembled) and push config. Materialize must land before files[] so
  // spec-level files can override org toolset config (last-wins layering).
  await Promise.all([
    agent.materializeToolsets(sandboxId, input.toolsets ?? []),
    agent.putConfig(sandboxId, specToAgentConfig(sandboxId, spec)),
  ]);
  if (spec.files && spec.files.length > 0) {
    await agent.writeFiles(sandboxId, toFileWrites(spec.files));
  }

  return podIp;
}
