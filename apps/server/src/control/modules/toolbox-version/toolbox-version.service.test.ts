import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolboxRepository as ToolboxRepositoryType } from "../toolbox/toolbox.repository.ts";
import type { ToolboxService as ToolboxServiceType } from "../toolbox/toolbox.service.ts";
import { recipeFingerprint } from "./fingerprint.ts";
import type { ToolboxVersionRepository as ToolboxVersionRepositoryType } from "./toolbox-version.repository.ts";
import type { ToolboxVersionService as ToolboxVersionServiceType } from "./toolbox-version.service.ts";

let ToolboxRepository: typeof ToolboxRepositoryType;
let ToolboxService: typeof ToolboxServiceType;
let ToolboxVersionRepository: typeof ToolboxVersionRepositoryType;
let ToolboxVersionService: typeof ToolboxVersionServiceType;
beforeAll(async () => {
  // `initDatabase()` is a process-wide singleton (shared by control/ and
  // runtime/, `shared/lib/db.ts`) — idempotent, so whichever test file's
  // `beforeAll` runs first "wins" the DATA_DIR. Deliberately no `afterAll`
  // rm: another test file's `beforeAll` may still be holding this same
  // connection open when bun runs files back-to-back in one process.
  const dataDir = await mkdtemp(
    join(tmpdir(), "atelier-toolbox-version-test-"),
  );
  process.env.DATA_DIR = dataDir;
  // Resolve migrations from this file's location so the suite passes from any
  // cwd (bun test at the repo root vs. apps/server), not just when
  // `process.cwd()/drizzle` happens to exist.
  process.env.MIGRATIONS_DIR ??= join(import.meta.dir, "../../../../drizzle");
  const { initDatabase } = await import("../../db/client.ts");
  await initDatabase();
  ({ ToolboxRepository } = await import("../toolbox/toolbox.repository.ts"));
  ({ ToolboxService } = await import("../toolbox/toolbox.service.ts"));
  ({ ToolboxVersionRepository } = await import(
    "./toolbox-version.repository.ts"
  ));
  ({ ToolboxVersionService } = await import("./toolbox-version.service.ts"));
});

function makeToolbox() {
  const toolboxService = new ToolboxService(new ToolboxRepository());
  return toolboxService.create(
    { type: "org", id: `org-${Math.random().toString(36).slice(2)}` },
    {
      slug: "my-tools",
      description: "d",
      build: ["echo hi"],
      paths: ["~/x"],
    },
  );
}

describe("ToolboxVersionService", () => {
  test("create assigns monotonic labels per toolbox", () => {
    const service = new ToolboxVersionService(new ToolboxVersionRepository());
    const tb = makeToolbox();
    const v1 = service.create(tb.id, {
      ref: "toolsets/tb/org/x/my-tools@sha256:aaa",
      description: "first",
      provenance: { kind: "captured", capturedFrom: "sbx-1", capturedBy: "u1" },
      recipeFingerprint: "fp1",
    });
    const v2 = service.create(tb.id, {
      ref: "toolsets/tb/org/x/my-tools@sha256:bbb",
      description: "second",
      provenance: { kind: "captured", capturedFrom: "sbx-2", capturedBy: "u1" },
      recipeFingerprint: "fp1",
    });
    expect(v1.label).toBe(1);
    expect(v2.label).toBe(2);
  });

  test("listByToolbox returns versions ordered by label ascending", () => {
    const service = new ToolboxVersionService(new ToolboxVersionRepository());
    const tb = makeToolbox();
    service.create(tb.id, {
      ref: "ref-1",
      description: "a",
      provenance: { kind: "built", recipeHash: "h1" },
      recipeFingerprint: "fp",
    });
    service.create(tb.id, {
      ref: "ref-2",
      description: "b",
      provenance: { kind: "built", recipeHash: "h1" },
      recipeFingerprint: "fp",
    });
    const listed = service.listByToolbox(tb.id);
    expect(listed.map((v) => v.label)).toEqual([1, 2]);
    expect(listed.map((v) => v.ref)).toEqual(["ref-1", "ref-2"]);
  });

  test("delete removes a version", () => {
    const service = new ToolboxVersionService(new ToolboxVersionRepository());
    const tb = makeToolbox();
    const v = service.create(tb.id, {
      ref: "ref-del",
      description: "d",
      provenance: { kind: "built", recipeHash: "h1" },
      recipeFingerprint: "fp",
    });
    service.delete(v.id);
    expect(service.listByToolbox(tb.id)).toHaveLength(0);
  });

  test("toolbox active-version pointer: set/get/clear round-trips", () => {
    const toolboxService = new ToolboxService(new ToolboxRepository());
    const versionService = new ToolboxVersionService(
      new ToolboxVersionRepository(),
    );
    const tb = makeToolbox();
    expect(toolboxService.getActiveVersionId(tb.id)).toBeNull();

    const v = versionService.create(tb.id, {
      ref: "ref-pin",
      description: "d",
      provenance: { kind: "built", recipeHash: "h1" },
      recipeFingerprint: "fp",
    });
    toolboxService.setActiveVersionId(tb.id, v.id);
    expect(toolboxService.getActiveVersionId(tb.id)).toBe(v.id);

    toolboxService.setActiveVersionId(tb.id, null);
    expect(toolboxService.getActiveVersionId(tb.id)).toBeNull();
  });

  test("recordBuilt is idempotent per ref", () => {
    const service = new ToolboxVersionService(new ToolboxVersionRepository());
    const tb = makeToolbox();
    const first = service.recordBuilt(tb.id, {
      ref: "ref-built-1",
      recipeFingerprint: "fp1",
      sourceImage: "img:1",
    });
    expect(first).toBeDefined();
    expect(first?.provenance).toEqual({
      kind: "built",
      recipeHash: "fp1",
      sourceImage: "img:1",
    });

    const second = service.recordBuilt(tb.id, {
      ref: "ref-built-1",
      recipeFingerprint: "fp1",
      sourceImage: "img:1",
    });
    expect(second).toBeUndefined();
    expect(service.listByToolbox(tb.id)).toHaveLength(1);
  });

  test("existsByRef / getByToolboxAndRef reflect recorded rows", () => {
    const repository = new ToolboxVersionRepository();
    const service = new ToolboxVersionService(repository);
    const tb = makeToolbox();
    expect(service.existsByRef(tb.id, "ref-x")).toBe(false);
    expect(repository.getByToolboxAndRef(tb.id, "ref-x")).toBeUndefined();

    service.create(tb.id, {
      ref: "ref-x",
      description: "d",
      provenance: { kind: "built", recipeHash: "h1" },
      recipeFingerprint: "fp",
    });
    expect(service.existsByRef(tb.id, "ref-x")).toBe(true);
    expect(repository.getByToolboxAndRef(tb.id, "ref-x")?.ref).toBe("ref-x");
  });

  test("pruneOldVersions keeps the active pin and the newest built row even outside the newest-N window", () => {
    const service = new ToolboxVersionService(new ToolboxVersionRepository());
    const tb = makeToolbox();

    // v1: the only built row — must survive as "newest built" even once it
    // ages out of the newest-10 window.
    const v1 = service.create(tb.id, {
      ref: "v1",
      description: "old built",
      provenance: { kind: "built", recipeHash: "h1" },
      recipeFingerprint: "fp",
    });
    // v2: pinned — must survive even though it also ages out of the window.
    const v2 = service.create(tb.id, {
      ref: "v2",
      description: "pinned capture",
      provenance: { kind: "captured", capturedFrom: "sbx", capturedBy: "u1" },
      recipeFingerprint: "fp",
    });
    // v3: neither pinned, built, nor in the newest-10 window — must be pruned.
    const v3 = service.create(tb.id, {
      ref: "v3",
      description: "stale capture",
      provenance: { kind: "captured", capturedFrom: "sbx", capturedBy: "u1" },
      recipeFingerprint: "fp",
    });
    // v4..v13: 10 more captures — exactly fills the newest-10 window.
    for (let i = 4; i <= 13; i++) {
      service.create(tb.id, {
        ref: `v${i}`,
        description: `capture ${i}`,
        provenance: { kind: "captured", capturedFrom: "sbx", capturedBy: "u1" },
        recipeFingerprint: "fp",
      });
    }

    const deleted = service.pruneOldVersions(tb.id, v2.id);
    const remaining = service.listByToolbox(tb.id);
    const remainingIds = new Set(remaining.map((v) => v.id));

    expect(remainingIds.has(v1.id)).toBe(true); // newest built row
    expect(remainingIds.has(v2.id)).toBe(true); // active pin
    expect(remainingIds.has(v3.id)).toBe(false); // pruned
    expect(deleted.map((v) => v.id)).toEqual([v3.id]);
    expect(remaining).toHaveLength(12); // 13 total - 1 pruned
  });

  test("pruneOldVersions deletes rows outside the keep-set", () => {
    const service = new ToolboxVersionService(new ToolboxVersionRepository());
    const tb = makeToolbox();
    const versions = Array.from({ length: 13 }, (_, i) =>
      service.create(tb.id, {
        ref: `r${i + 1}`,
        description: `v${i + 1}`,
        provenance: { kind: "captured", capturedFrom: "sbx", capturedBy: "u1" },
        recipeFingerprint: "fp",
      }),
    );
    const deleted = service.pruneOldVersions(tb.id, null);
    const remaining = service.listByToolbox(tb.id);
    expect(remaining).toHaveLength(10);
    expect(deleted).toHaveLength(3);
    // The oldest 3 (v1..v3) are the ones pruned — none are pinned/built.
    const deletedIds = new Set(deleted.map((v) => v.id));
    for (const v of versions.slice(0, 3)) {
      expect(deletedIds.has(v.id)).toBe(true);
    }
    for (const v of versions.slice(3)) {
      expect(deletedIds.has(v.id)).toBe(false);
    }
  });

  test("recipeFingerprint is stable and changes when build/paths/source change", () => {
    const base = { build: ["echo hi"], paths: ["~/x"] };
    const fp1 = recipeFingerprint(base);
    const fp2 = recipeFingerprint({ build: ["echo hi"], paths: ["~/x"] });
    expect(fp1).toBe(fp2);

    const fpBuildChanged = recipeFingerprint({
      build: ["echo bye"],
      paths: ["~/x"],
    });
    expect(fpBuildChanged).not.toBe(fp1);

    const fpPathsChanged = recipeFingerprint({
      build: ["echo hi"],
      paths: ["~/y"],
    });
    expect(fpPathsChanged).not.toBe(fp1);

    const fpSourceChanged = recipeFingerprint({
      ...base,
      source: { image: "foo" },
    });
    expect(fpSourceChanged).not.toBe(fp1);
  });
});
