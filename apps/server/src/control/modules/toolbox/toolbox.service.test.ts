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
