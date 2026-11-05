/**
 * Toolbox refresh orchestration (docs/toolbox-versions.md section 10)
 * against the real control plane and a scripted runtime: what gets saved,
 * pinned and published, what is recorded on the toolbox, and how the
 * scheduler and the one-refresh-at-a-time rule behave.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ToolboxConfig,
  ToolsetBuildRequest,
  ToolsetRefreshRequest,
  ToolsetRefreshResult,
} from "@atelier/spec";
import type { ControlContainer } from "../control/index.ts";
import type { JobService as JobServiceType } from "../runtime/jobs.service.ts";
import type { ServerContainer } from "./container.ts";
import type * as RefreshModule from "./toolbox-refresh.ts";

let dataDir: string;
let control: ControlContainer;
let JobService: typeof JobServiceType;
let mod: typeof RefreshModule;
let ToolboxOps: typeof import("./app/toolbox-ops.ts").ToolboxOps;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "atelier-toolbox-refresh-test-"));
  process.env.DATA_DIR = dataDir;
  process.env.MIGRATIONS_DIR ??= join(import.meta.dir, "../../drizzle");
  const { initDatabase } = await import("../control/db/client.ts");
  await initDatabase();
  const { createControlContainer } = await import("../control/index.ts");
  control = createControlContainer();
  ({ JobService } = await import("../runtime/jobs.service.ts"));
  mod = await import("./toolbox-refresh.ts");
  ({ ToolboxOps } = await import("./app/toolbox-ops.ts"));
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const digest = (c: string) => `sha256:${c.repeat(64)}`;

/** A runtime that answers `refreshToolset` with `answer` (a function can
 * act mid-refresh, e.g. move the pin, or throw). */
function makeContainer(
  answer: (req: ToolsetRefreshRequest) => Promise<ToolsetRefreshResult>,
) {
  const calls = {
    refresh: [] as ToolsetRefreshRequest[],
    builds: [] as ToolsetBuildRequest[],
    published: [] as string[],
  };
  const runtime = {
    refreshToolset: async (req: ToolsetRefreshRequest) => {
      calls.refresh.push(req);
      return answer(req);
    },
    buildToolset: async (req: ToolsetBuildRequest) => {
      calls.builds.push(req);
      return { ref: `toolsets/${req.name}@${digest("c")}` };
    },
    publishToolset: (ref: string) => {
      calls.published.push(ref);
      return { ref, private: false };
    },
    resolveSourceImage: async () => "registry.test/dev-base@sha256:new",
    defaultImage: () => "dev-base",
    deleteToolset: () => {},
  };
  const jobs = new JobService();
  const container = {
    control,
    runtime,
    jobs,
    toolboxOps: new ToolboxOps({ control, runtime, jobs } as never),
  } as unknown as ServerContainer;
  return { container, calls };
}

let seq = 0;
/** A toolbox with update commands and a pinned captured version. */
function pinnedToolbox(): {
  tb: ToolboxConfig;
  pinnedId: string;
  pinnedRef: string;
} {
  seq++;
  const tb = control.toolboxService.create(`org-refresh-${seq}`, {
    slug: "pi-web",
    description: "pi",
    build: ["npm i -g pi"],
    paths: ["~/.local/bin", "~/.pi/agent"],
    refresh: ["pi update --all"],
  });
  const pinnedRef = `toolsets/tb/${tb.id}@${digest("a")}`;
  const pinned = control.toolboxVersionService.create(tb.id, {
    ref: pinnedRef,
    description: "pi update",
    provenance: { kind: "captured", capturedFrom: "sbx", capturedBy: "u1" },
    recipeFingerprint: "fp",
  });
  control.toolboxService.setActiveVersionId(tb.id, pinned.id);
  return { tb, pinnedId: pinned.id, pinnedRef };
}

describe("runToolboxRefresh", () => {
  test("changed: saves, publishes and pins a refreshed version", async () => {
    const { tb, pinnedId, pinnedRef } = pinnedToolbox();
    const newRef = `toolsets/tb/${tb.id}@${digest("b")}`;
    const { container, calls } = makeContainer(async () => ({
      changed: true,
      ref: newRef,
    }));

    const out = await mod.runToolboxRefresh(container, tb.id, {
      trigger: "manual",
      userId: "u1",
    });

    expect(out.outcome).toBe("updated");
    if (out.outcome !== "updated") return;
    expect(out.pinned).toBe(true);
    expect(calls.refresh[0]).toMatchObject({
      name: `tb/${tb.id}`,
      base: { ref: pinnedRef },
      steps: ["pi update --all"],
      paths: ["~/.local/bin", "~/.pi/agent"],
    });
    expect(calls.builds).toHaveLength(0);
    expect(calls.published).toEqual([newRef]);
    expect(control.toolboxService.getActiveVersionId(tb.id)).toBe(
      out.versionId,
    );
    const version = control.toolboxVersionService.get(out.versionId);
    expect(version.description).toBe("Refresh: pi update --all");
    expect(version.provenance).toEqual({
      kind: "refreshed",
      from: pinnedRef,
      fromVersionId: pinnedId,
      steps: ["pi update --all"],
      trigger: "manual",
      by: "u1",
      sourceImage: "registry.test/dev-base@sha256:new",
    });
    const last = control.toolboxService.get(tb.id).lastRefresh;
    expect(last).toMatchObject({
      trigger: "manual",
      outcome: "updated",
      versionId: out.versionId,
      pinned: true,
    });
  });

  test("unchanged: no version, the pin stays", async () => {
    const { tb, pinnedId } = pinnedToolbox();
    const { container } = makeContainer(async () => ({ changed: false }));
    const before = control.toolboxVersionService.listByToolbox(tb.id).length;

    const out = await mod.runToolboxRefresh(container, tb.id, {
      trigger: "schedule",
    });

    expect(out).toEqual({ outcome: "unchanged", versionId: pinnedId });
    expect(control.toolboxVersionService.listByToolbox(tb.id)).toHaveLength(
      before,
    );
    expect(control.toolboxService.getActiveVersionId(tb.id)).toBe(pinnedId);
    expect(control.toolboxService.get(tb.id).lastRefresh).toMatchObject({
      trigger: "schedule",
      outcome: "unchanged",
      versionId: pinnedId,
    });
  });

  test("nothing pinned: starts from the recipe build, then pins", async () => {
    const tb = control.toolboxService.create("org-refresh-recipe", {
      slug: "pi-web",
      description: "pi",
      build: ["npm i -g pi"],
      paths: ["~/.local/bin"],
      refresh: ["pi update --all"],
    });
    const builtRef = `toolsets/tb/${tb.id}@${digest("c")}`;
    const { container, calls } = makeContainer(async () => ({
      changed: true,
      ref: `toolsets/tb/${tb.id}@${digest("d")}`,
    }));

    const out = await mod.runToolboxRefresh(container, tb.id, {
      trigger: "manual",
    });

    expect(calls.builds).toHaveLength(1);
    expect(calls.refresh[0]?.base.ref).toBe(builtRef);
    const built = control.toolboxVersionService.findByRef(tb.id, builtRef);
    expect(built?.provenance.kind).toBe("built");
    if (out.outcome !== "updated") throw new Error("expected an update");
    expect(out.pinned).toBe(true);
    const version = control.toolboxVersionService.get(out.versionId);
    expect(version.provenance).toMatchObject({
      kind: "refreshed",
      from: builtRef,
      fromVersionId: built?.id,
    });
  });

  test("a pin moved during the refresh is kept", async () => {
    const { tb, pinnedId } = pinnedToolbox();
    const other = control.toolboxVersionService.create(tb.id, {
      ref: `toolsets/tb/${tb.id}@${digest("e")}`,
      description: "by hand",
      provenance: { kind: "captured", capturedFrom: "sbx", capturedBy: "u2" },
      recipeFingerprint: "fp",
    });
    const { container } = makeContainer(async () => {
      control.toolboxService.setActiveVersionId(tb.id, other.id);
      return {
        changed: true,
        ref: `toolsets/tb/${tb.id}@${digest("f")}`,
      };
    });

    const out = await mod.runToolboxRefresh(container, tb.id, {
      trigger: "schedule",
    });

    expect(out).toMatchObject({ outcome: "updated", pinned: false });
    expect(control.toolboxService.getActiveVersionId(tb.id)).toBe(other.id);
    expect(control.toolboxService.getActiveVersionId(tb.id)).not.toBe(pinnedId);
    expect(control.toolboxService.get(tb.id).lastRefresh?.pinned).toBe(false);
  });

  test("failure: recorded on the toolbox, the pin untouched", async () => {
    const { tb, pinnedId } = pinnedToolbox();
    const { container } = makeContainer(async () => {
      throw new Error("build step failed (exit 1): pi update --all");
    });

    await expect(
      mod.runToolboxRefresh(container, tb.id, { trigger: "schedule" }),
    ).rejects.toThrow(/exit 1/);

    expect(control.toolboxService.getActiveVersionId(tb.id)).toBe(pinnedId);
    expect(control.toolboxService.get(tb.id).lastRefresh).toMatchObject({
      outcome: "failed",
      trigger: "schedule",
      error: "build step failed (exit 1): pi update --all",
    });
  });
});

describe("startToolboxRefresh", () => {
  test("refuses a toolbox without update commands", () => {
    const tb = control.toolboxService.create("user-refresh-none", {
      slug: "vscode",
      description: "d",
      build: ["x"],
      paths: ["~/.x"],
    });
    const { container } = makeContainer(async () => ({ changed: false }));
    expect(() =>
      mod.startToolboxRefresh(container, tb.id, { trigger: "manual" }),
    ).toThrow(/update commands/);
  });

  test("one refresh per toolbox at a time", async () => {
    const { tb } = pinnedToolbox();
    let release: (value: ToolsetRefreshResult) => void = () => {};
    const { container, calls } = makeContainer(
      () =>
        new Promise<ToolsetRefreshResult>((resolve) => {
          release = resolve;
        }),
    );

    const first = mod.startToolboxRefresh(container, tb.id, {
      trigger: "manual",
    });
    const second = mod.startToolboxRefresh(container, tb.id, {
      trigger: "manual",
    });
    expect(first.started).toBe(true);
    expect(second.started).toBe(false);
    expect(second.job.id).toBe(first.job.id);

    // Let the job reach the runtime, then finish it.
    for (let i = 0; i < 20 && calls.refresh.length === 0; i++) {
      await Bun.sleep(5);
    }
    release({ changed: false });
    for (let i = 0; i < 20 && mod.activeRefreshJob(container, tb.id); i++) {
      await Bun.sleep(5);
    }
    expect(mod.activeRefreshJob(container, tb.id)).toBeUndefined();
    expect(control.toolboxService.get(tb.id).lastRefresh?.jobId).toBe(
      first.job.id,
    );
  });
});

describe("runDueToolboxRefreshes", () => {
  test("starts due refreshes and plans the next run first", () => {
    const tb = control.toolboxService.create("user-refresh-due", {
      slug: "pi-web",
      description: "pi",
      build: ["x"],
      paths: ["~/.local/bin"],
      refresh: ["pi update --all"],
      refreshSchedule: "@daily",
    });
    const planned = new Date(tb.nextRefreshAt ?? "");
    const at = new Date(planned.getTime() + 1000);
    const { container } = makeContainer(async () => ({ changed: false }));

    expect(mod.runDueToolboxRefreshes(container, at)).toBeGreaterThan(0);
    expect(mod.activeRefreshJob(container, tb.id)).toBeDefined();
    const next = control.toolboxService.get(tb.id).nextRefreshAt ?? "";
    expect(new Date(next).getTime()).toBeGreaterThan(at.getTime());
  });

  test("a due toolbox that can't refresh records the failure", () => {
    const tb = control.toolboxService.create("user-refresh-nopaths", {
      slug: "broken",
      description: "d",
      build: [],
      paths: [],
      refresh: ["pi update --all"],
      refreshSchedule: "@weekly",
    });
    const at = new Date(new Date(tb.nextRefreshAt ?? "").getTime() + 1000);
    const { container } = makeContainer(async () => ({ changed: false }));

    mod.runDueToolboxRefreshes(container, at);

    expect(control.toolboxService.get(tb.id).lastRefresh).toMatchObject({
      outcome: "failed",
      trigger: "schedule",
      error: "toolbox has no paths to capture",
    });
  });
});
