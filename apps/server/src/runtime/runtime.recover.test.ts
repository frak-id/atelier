/**
 * `recoverRestarted`: a running sandbox whose agent came back without config
 * (its compute restarted without the runtime, e.g. a host reboot) gets
 * resume's tail again on the compute that is there; every other sandbox is
 * left alone.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { SandboxSpec } from "@atelier/spec";
import { RuntimeService } from "./runtime.service.ts";
import { FakeAgentClient, fakeRuntimeDeps } from "./runtime.test-support.ts";
import * as stores from "./store.ts";
import { useTestDatabase } from "./test-database.ts";

beforeEach(() => useTestDatabase());

const spec: SandboxSpec = {
  source: { image: "registry.test/base:1" },
  resources: { vcpus: 1, memoryMb: 512 },
  files: [{ path: "/home/dev/.note", content: "hi" }],
};

const NEW_HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINewHostKey root@sb";

/** An agent whose config a test can wipe, as a restarted guest's is. */
function restartableAgent() {
  const agent = new FakeAgentClient();
  const state = {
    configured: true,
    reachable: true,
    calls: [] as string[],
    invalidated: [] as string[],
    hookFails: false,
  };
  agent.health = async () => {
    if (!state.reachable) throw new Error("connect ECONNREFUSED");
    return {
      status: "ok",
      uptime: 1,
      configured: state.configured,
      healthy: true,
    };
  };
  agent.putConfig = async () => {
    state.calls.push("config");
    state.configured = true;
  };
  agent.materializeToolsets = async () => {
    state.calls.push("materialize");
  };
  agent.writeFiles = async (_id, files) => {
    state.calls.push("files");
    return { results: files.map((f) => ({ path: f.path, success: true })) };
  };
  agent.runHook = async (_id, phase) => {
    state.calls.push(phase);
    return state.hookFails
      ? {
          success: false,
          results: [
            { command: "refresh", exitCode: 1, stdout: "", stderr: "boom" },
          ],
        }
      : { success: true, results: [] };
  };
  agent.reconcile = async () => {
    state.calls.push("reconcile");
  };
  const invalidate = agent.invalidatePodIp.bind(agent);
  agent.invalidatePodIp = (id) => {
    state.invalidated.push(id);
    invalidate(id);
  };
  return { agent, state };
}

async function setup() {
  const { agent, state } = restartableAgent();
  const sandboxes = new stores.DrizzleSandboxStore();
  const runtime = new RuntimeService({
    ...fakeRuntimeDeps(),
    agent,
    sandboxes,
    snapshots: new stores.DrizzleSnapshotStore(),
    toolsets: new stores.DrizzleToolsetStore(),
    sandboxToolsetRefs: new stores.DrizzleSandboxToolsetRefStore(),
  });
  await runtime.create(spec, { id: "sb" });
  state.calls.length = 0;
  return { runtime, sandboxes, agent, state };
}

describe("recoverRestarted", () => {
  test("re-provisions a running sandbox whose agent lost its config", async () => {
    const { runtime, sandboxes, agent, state } = await setup();
    state.configured = false;
    agent.getSshHostKeys = async () => [NEW_HOST_KEY];

    expect(await runtime.recoverRestarted()).toEqual(["sb"]);
    // Resume's order: files/env, then onResume, then processes. No
    // postCreate: the disk is the sandbox's own.
    expect(state.calls.filter((c) => c !== "materialize")).toEqual([
      "config",
      "files",
      "onResume",
      "reconcile",
    ]);
    expect(state.calls).toContain("materialize");
    const record = sandboxes.get("sb");
    expect(record?.status).toBe("running");
    expect(record?.generated.sshHostKeys).toEqual([NEW_HOST_KEY]);
    expect(record?.generated.agentPassword).toBe("test-password");

    // Configured again: the next pass does nothing.
    state.calls.length = 0;
    expect(await runtime.recoverRestarted()).toEqual([]);
    expect(state.calls).toEqual([]);
  });

  test("leaves a configured agent alone", async () => {
    const { runtime, state } = await setup();
    expect(await runtime.recoverRestarted()).toEqual([]);
    expect(state.calls).toEqual([]);
  });

  test("an unreachable agent drops its cached endpoint and is retried later", async () => {
    const { runtime, state } = await setup();
    state.configured = false;
    state.reachable = false;
    expect(await runtime.recoverRestarted()).toEqual([]);
    expect(state.invalidated).toEqual(["sb"]);
    expect(state.calls).toEqual([]);

    state.reachable = true;
    expect(await runtime.recoverRestarted()).toEqual(["sb"]);
  });

  test("skips sandboxes that are not running", async () => {
    const { runtime, sandboxes, state } = await setup();
    await runtime.pause("sb");
    state.configured = false;
    state.calls.length = 0;
    expect(await runtime.recoverRestarted()).toEqual([]);
    expect(state.calls).toEqual([]);
    expect(sandboxes.get("sb")?.status).toBe("paused");
  });

  test("a failing onResume hook keeps the sandbox running, new host key pinned", async () => {
    const { runtime, sandboxes, agent, state } = await setup();
    state.configured = false;
    state.hookFails = true;
    agent.getSshHostKeys = async () => [NEW_HOST_KEY];

    expect(await runtime.recoverRestarted()).toEqual([]);
    expect(state.calls).toContain("onResume");
    expect(state.calls).not.toContain("reconcile");
    const record = sandboxes.get("sb");
    expect(record?.status).toBe("running");
    expect(record?.generated.sshHostKeys).toEqual([NEW_HOST_KEY]);

    // The config is back, so the hook is not re-run every minute.
    state.calls.length = 0;
    expect(await runtime.recoverRestarted()).toEqual([]);
    expect(state.calls).toEqual([]);
  });
});
