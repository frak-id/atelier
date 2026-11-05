/**
 * `reconcileOnStartup` for a `creating` fork copy: it is parked in `error`
 * with its own snapshot kept (resumable), or swept like any stuck create when
 * it owns no snapshot yet.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { SandboxSpec } from "@atelier/spec";
import { RuntimeService } from "./runtime.service.ts";
import { FakeBackend, fakeRuntimeDeps } from "./runtime.test-support.ts";
import * as stores from "./store.ts";
import { useTestDatabase } from "./test-database.ts";

beforeEach(() => useTestDatabase());

const spec: SandboxSpec = {
  source: { snapshot: "snap-copy" },
  resources: { vcpus: 1, memoryMb: 512 },
};

function setup() {
  const calls = { cleanup: [] as string[], restartable: [] as string[] };
  const backend = new FakeBackend();
  backend.cleanup = async (id: string) => {
    calls.cleanup.push(id);
    return true;
  };
  backend.deleteRestartable = async (id: string) => {
    calls.restartable.push(id);
  };
  const sandboxes = new stores.DrizzleSandboxStore();
  const snapshots = new stores.DrizzleSnapshotStore();
  const runtime = new RuntimeService({
    ...fakeRuntimeDeps(),
    backend,
    sandboxes,
    snapshots,
    toolsets: new stores.DrizzleToolsetStore(),
    sandboxToolsetRefs: new stores.DrizzleSandboxToolsetRefStore(),
  });
  const now = new Date().toISOString();
  sandboxes.create({
    id: "dst",
    spec,
    status: "creating",
    generated: {},
    metadata: {},
    createdAt: now,
    updatedAt: now,
  });
  return { runtime, sandboxes, snapshots, calls };
}

describe("reconcileOnStartup: stuck creating fork copy", () => {
  test("keeps the snapshot it owns (error, resumable)", async () => {
    const { runtime, sandboxes, snapshots, calls } = setup();
    snapshots.put({
      hash: "h".repeat(64),
      kind: "fork",
      ref: "snap-copy",
      image: "registry.test/base:1",
      sandboxId: "dst",
      createdAt: new Date().toISOString(),
    });
    await runtime.reconcileOnStartup();
    expect(sandboxes.get("dst")?.status).toBe("error");
    expect(calls).toEqual({ cleanup: [], restartable: ["dst"] });
    expect(snapshots.get("snap-copy")).toBeDefined();
  });

  test("without a snapshot row it is swept; resume says the snapshot is gone", async () => {
    const { runtime, sandboxes, calls } = setup();
    await runtime.reconcileOnStartup();
    expect(sandboxes.get("dst")?.status).toBe("error");
    expect(calls).toEqual({ cleanup: ["dst"], restartable: [] });
    await expect(runtime.resume("dst")).rejects.toThrow(
      /Snapshot .* not found/,
    );
  });
});
