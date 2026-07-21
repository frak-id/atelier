/**
 * DockerBackend orchestration — a real integration test against a live Docker
 * daemon and the bare agent image. It exercises the Docker-specific mechanics
 * end to end: `docker run` with dynamic loopback port publishing, endpoint
 * resolution via `docker port`, the agent becoming reachable at the mapped host
 * port (real `waitForAgent`), computeExists, and cleanup.
 *
 * The guest-filesystem-dependent tail (materialize/config/files) needs the full
 * dev-base sandbox image, so it is stubbed here; that path is a full-image
 * smoke test, not this orchestration test.
 *
 * OPT-IN — never runs in the normal (mock) suite. Requires a Docker daemon, the
 * agent image, and an explicit flag, and forces non-mock mode only then:
 *   docker build -t atelier-agent:local apps/agent-v2
 *   ATELIER_DOCKER_IT=1 bun test src/runtime/backend/docker.backend.test.ts
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import type { SandboxSpec } from "@atelier/spec";
import type { BootInput } from "../boot.ts";

const IMAGE = "atelier-agent:local";

function dockerReady(): boolean {
  if (spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0) {
    return false;
  }
  return (
    spawnSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" })
      .status === 0
  );
}

const RUN_IT = process.env.ATELIER_DOCKER_IT === "1" && dockerReady();

// Only when opted in: force non-mock (so waitForAgent really dials) and load
// the runtime modules dynamically. Guarded so the standard mock suite neither
// imports these nor sees the env change. A single `const` keeps TS narrowing
// clean (no non-null assertions).
async function loadMods() {
  process.env.ATELIER_SERVER_MODE ??= "production";
  return {
    AgentClient: (await import("../agent/index.ts")).AgentClient,
    DockerBackend: (await import("./docker.backend.ts")).DockerBackend,
    DockerVolumeBackend: (await import("./docker-volume.backend.ts"))
      .DockerVolumeBackend,
  };
}

const mods = RUN_IT ? await loadMods() : null;

const minimalSpec = (): SandboxSpec =>
  ({
    source: { kind: "image", image: IMAGE },
    resources: { vcpus: 1, memoryMb: 512 },
    ports: [],
  }) as unknown as SandboxSpec;

describe("DockerBackend (integration)", () => {
  const id = `it${Date.now().toString(36)}`;
  let cleanup: (() => Promise<void>) | undefined;

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  test.skipIf(!mods)(
    "boot runs a container, resolves the mapped endpoint, cleans up",
    async () => {
      if (!mods) return; // narrows for TS; skipIf already guards at runtime.
      const { DockerBackend, AgentClient, DockerVolumeBackend } = mods;

      const backend = new DockerBackend({
        volumes: new DockerVolumeBackend(),
        // Bare agent image has no /etc/sandbox/sandbox-boot.sh — use its own
        // entrypoint (/atelier-agent).
        bootScript: false,
      });
      cleanup = () => backend.cleanup(id).then(() => {});

      const agent = new AgentClient((sid) => backend.resolveAgentEndpoint(sid));
      // The guest-fs tail needs the dev-base image; stub it so the test targets
      // orchestration. waitForAgent (the real endpoint dial) is NOT stubbed.
      agent.materializeToolsets = async () => {};
      agent.putConfig = async () => {};

      const input: BootInput = { image: IMAGE };
      const out = await backend.boot(id, minimalSpec(), input, agent);

      expect(out.podName).toBe(`sandbox-${id}`);
      expect(out.podIp).toBe("127.0.0.1");

      // Endpoint resolves to mapped loopback host ports.
      const ep = await backend.resolveAgentEndpoint(id);
      expect(ep).not.toBeNull();
      expect(ep?.host).toBe("127.0.0.1");
      expect(ep?.agentPort).toBeGreaterThan(0);
      expect(ep?.attachPort).toBeGreaterThan(0);
      expect(ep?.terminalPort).toBeGreaterThan(0);

      // The agent is actually reachable on the mapped port.
      const health = await fetch(
        `http://127.0.0.1:${ep?.agentPort}/health`,
      ).then((r) => r.json() as Promise<{ healthy: boolean }>);
      expect(health.healthy).toBe(true);

      expect(await backend.computeExists(id)).toBe(true);

      await backend.cleanup(id);
      expect(await backend.computeExists(id)).toBe(false);
    },
    120_000,
  );
});
