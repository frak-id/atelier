import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../../../shared/errors.ts";
import type { ToolboxRepository as ToolboxRepositoryType } from "./toolbox.repository.ts";
import type { ToolboxService as ToolboxServiceType } from "./toolbox.service.ts";

let ToolboxRepository: typeof ToolboxRepositoryType;
let ToolboxService: typeof ToolboxServiceType;
let dataDir: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "atelier-toolbox-test-"));
  process.env.DATA_DIR = dataDir;
  // Resolve migrations from this file's location so the suite passes from any
  // cwd (bun test at the repo root vs. apps/server), not just when
  // `process.cwd()/drizzle` happens to exist.
  process.env.MIGRATIONS_DIR ??= join(import.meta.dir, "../../../../drizzle");
  const { initDatabase } = await import("../../db/client.ts");
  await initDatabase();
  ({ ToolboxRepository } = await import("./toolbox.repository.ts"));
  ({ ToolboxService } = await import("./toolbox.service.ts"));
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("ToolboxService", () => {
  test("slug uniqueness is per-owner, not global", () => {
    const service = new ToolboxService(new ToolboxRepository());
    const orgA = { type: "org", id: "org-slug-a" } as const;
    const orgB = { type: "org", id: "org-slug-b" } as const;
    const input = {
      slug: "shared-slug",
      description: "d",
      build: ["echo hi"],
      paths: ["~/x"],
    };
    service.create(orgA, input);
    expect(() => service.create(orgA, input)).toThrow(ValidationError);
    // Same slug, different org: no conflict.
    expect(() => service.create(orgB, input)).not.toThrow();
  });

  test("a user and an org may share a slug (owner axis is distinct)", () => {
    const service = new ToolboxService(new ToolboxRepository());
    const input = {
      slug: "my-tools",
      description: "d",
      build: ["echo hi"],
      paths: ["~/x"],
    };
    const org = { type: "org", id: "org-shared-axis" } as const;
    const user = { type: "user", id: "user-shared-axis" } as const;
    const orgTb = service.create(org, input);
    const userTb = service.create(user, input);
    expect(orgTb.ownerType).toBe("org");
    expect(userTb.ownerType).toBe("user");
    expect(service.list(user).map((c) => c.slug)).toEqual(["my-tools"]);
    expect(service.list(org).map((c) => c.slug)).toEqual(["my-tools"]);
  });

  test("update clears source with null but keeps it when the key is absent", () => {
    const service = new ToolboxService(new ToolboxRepository());
    const owner = { type: "org", id: "org-clear-source" } as const;
    const created = service.create(owner, {
      slug: "with-source",
      description: "d",
      build: [],
      paths: [],
      source: { image: "dev-base" },
    });
    expect(created.source).toEqual({ image: "dev-base" });

    // Absent key keeps the existing override.
    const kept = service.update(created.id, { description: "d2" });
    expect(kept.source).toEqual({ image: "dev-base" });

    // Explicit null clears it.
    const cleared = service.update(created.id, { source: null });
    expect(cleared.source).toBeUndefined();
  });

  test("listAutoInject orders oldest-first and excludes non-auto-inject", () => {
    const repository = new ToolboxRepository();
    const owner = { type: "org", id: "org-order" } as const;
    const base = Date.now();
    const at = (offsetMs: number) => new Date(base + offsetMs).toISOString();

    repository.create({
      id: "t-third",
      ownerType: owner.type,
      ownerId: owner.id,
      slug: "c",
      description: "d",
      build: [],
      paths: [],
      autoInject: true,
      refresh: [],
      createdAt: at(2000),
      updatedAt: at(2000),
    });
    repository.create({
      id: "t-first",
      ownerType: owner.type,
      ownerId: owner.id,
      slug: "a",
      description: "d",
      build: [],
      paths: [],
      autoInject: true,
      refresh: [],
      createdAt: at(0),
      updatedAt: at(0),
    });
    repository.create({
      id: "t-disabled",
      ownerType: owner.type,
      ownerId: owner.id,
      slug: "b",
      description: "d",
      build: [],
      paths: [],
      autoInject: false,
      refresh: [],
      createdAt: at(1000),
      updatedAt: at(1000),
    });

    const service = new ToolboxService(repository);
    expect(service.listAutoInject(owner).map((c) => c.id)).toEqual([
      "t-first",
      "t-third",
    ]);
  });
});

describe("ToolboxService refresh schedule", () => {
  const base = {
    description: "d",
    build: ["echo hi"],
    paths: ["~/x"],
  };

  test("a schedule with update commands plans the next run", () => {
    const service = new ToolboxService(new ToolboxRepository());
    const tb = service.create(
      { type: "user", id: "user-sched-plan" },
      {
        ...base,
        slug: "pi",
        refresh: ["pi update --all"],
        refreshSchedule: "0 4 * * *",
      },
    );
    expect(tb.refresh).toEqual(["pi update --all"]);
    expect(tb.refreshSchedule).toBe("0 4 * * *");
    const next = new Date(tb.nextRefreshAt ?? "");
    expect(next.getUTCHours()).toBe(4);
    expect(next.getUTCMinutes()).toBe(0);
    expect(next.getTime()).toBeGreaterThan(Date.now());
  });

  test("no update commands: the schedule is kept but nothing is planned", () => {
    const service = new ToolboxService(new ToolboxRepository());
    const tb = service.create(
      { type: "user", id: "user-sched-dormant" },
      { ...base, slug: "pi", refreshSchedule: "@daily" },
    );
    expect(tb.refresh).toEqual([]);
    expect(tb.refreshSchedule).toBe("@daily");
    expect(tb.nextRefreshAt).toBeUndefined();

    const armed = service.update(tb.id, { refresh: ["pi update --all"] });
    expect(armed.nextRefreshAt).toBeDefined();
    const disarmed = service.update(tb.id, { refresh: [] });
    expect(disarmed.nextRefreshAt).toBeUndefined();
  });

  test("null clears the schedule; an unrelated edit keeps the plan", () => {
    const service = new ToolboxService(new ToolboxRepository());
    const tb = service.create(
      { type: "user", id: "user-sched-clear" },
      {
        ...base,
        slug: "pi",
        refresh: ["pi update --all"],
        refreshSchedule: "@weekly",
      },
    );
    const kept = service.update(tb.id, { description: "d2" });
    expect(kept.refreshSchedule).toBe("@weekly");
    expect(kept.nextRefreshAt).toBe(tb.nextRefreshAt);

    const cleared = service.update(tb.id, { refreshSchedule: null });
    expect(cleared.refreshSchedule).toBeUndefined();
    expect(cleared.nextRefreshAt).toBeUndefined();
    expect(service.get(tb.id).nextRefreshAt).toBeUndefined();
  });

  test("rejects invalid and too-frequent schedules", () => {
    const service = new ToolboxService(new ToolboxRepository());
    const owner = { type: "user", id: "user-sched-invalid" } as const;
    for (const refreshSchedule of ["nope", "* * * * *", "*/30 * * * *"]) {
      expect(() =>
        service.create(owner, {
          ...base,
          slug: "pi",
          refresh: ["x"],
          refreshSchedule,
        }),
      ).toThrow(ValidationError);
    }
    const tb = service.create(owner, { ...base, slug: "pi" });
    expect(() =>
      service.update(tb.id, { refreshSchedule: "0 0 30 2 *" }),
    ).toThrow(ValidationError);
  });

  test("due toolboxes are listed, then advanced past now", () => {
    const service = new ToolboxService(new ToolboxRepository());
    const tb = service.create(
      { type: "user", id: "user-sched-due" },
      {
        ...base,
        slug: "pi",
        refresh: ["pi update --all"],
        refreshSchedule: "@daily",
      },
    );
    const planned = new Date(tb.nextRefreshAt ?? "");
    const before = new Date(planned.getTime() - 1000);
    const after = new Date(planned.getTime() + 1000);
    const due = (at: Date) =>
      service.listDueForRefresh(at).filter((c) => c.id === tb.id);
    expect(due(before)).toHaveLength(0);
    expect(due(after)).toHaveLength(1);

    const next = service.advanceRefreshSchedule(tb.id, after);
    expect(next).not.toBeNull();
    expect(new Date(next ?? "").getTime()).toBeGreaterThan(after.getTime());
    expect(due(after)).toHaveLength(0);
  });

  test("recordRefresh stores the outcome without touching updatedAt", () => {
    const service = new ToolboxService(new ToolboxRepository());
    const tb = service.create(
      { type: "user", id: "user-sched-record" },
      { ...base, slug: "pi", refresh: ["pi update --all"] },
    );
    service.recordRefresh(tb.id, {
      at: new Date().toISOString(),
      trigger: "manual",
      outcome: "failed",
      error: "boom",
    });
    const read = service.get(tb.id);
    expect(read.lastRefresh?.outcome).toBe("failed");
    expect(read.lastRefresh?.error).toBe("boom");
    expect(read.updatedAt).toBe(tb.updatedAt);
  });
});
