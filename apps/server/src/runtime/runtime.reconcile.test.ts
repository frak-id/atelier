/**
 * `reconcileOnStartup` for a `creating` fork copy: it is parked in `error`
 * with its own snapshot kept (resumable), or swept like any stuck create when
 * it owns no snapshot yet. Runs in `local` mode because the sweep is skipped
 * in mock mode.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SandboxSpec } from "@atelier/spec";

process.env.ATELIER_SERVER_MODE = "local";

let RuntimeService: typeof import("./runtime.service.ts").RuntimeService;
let stores: typeof import("./store.ts");
let config: typeof import("../shared/lib/config.ts").config;
let previousMode: typeof config.server.mode;

beforeAll(async () => {
  // The env line above only counts if this file loads the config first.
  ({ config } = await import("../shared/lib/config.ts"));
  previousMode = config.server.mode;
  config.server.mode = "local";
  ({ RuntimeService } = await import("./runtime.service.ts"));
  stores = await import("./store.ts");
});

afterAll(() => {
  config.server.mode = previousMode;
});

const spec: SandboxSpec = {
  source: { snapshot: "snap-copy" },
  resources: { vcpus: 1, memoryMb: 512 },
};

function setup() {
  const calls = { cleanup: [] as string[], restartable: [] as string[] };
  const backend = {
    cleanup: async (id: string) => {
      calls.cleanup.push(id);
      return true;
    },
    deleteRestartable: async (id: string) => {
      calls.restartable.push(id);
    },
  };
  const sandboxes = new stores.InMemorySandboxStore();
  const snapshots = new stores.InMemorySnapshotStore();
  const runtime = new RuntimeService({
    // biome-ignore lint/suspicious/noExplicitAny: only the two teardown calls are exercised
    backend: backend as any,
    sandboxes,
    snapshots,
    toolsets: new stores.InMemoryToolsetStore(),
    sandboxToolsetRefs: new stores.InMemorySandboxToolsetRefStore(),
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
