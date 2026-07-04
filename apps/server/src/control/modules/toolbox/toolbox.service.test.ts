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
  const { initDatabase } = await import("../../db/client.ts");
  await initDatabase();
  ({ ToolboxRepository } = await import("./toolbox.repository.ts"));
  ({ ToolboxService } = await import("./toolbox.service.ts"));
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("ToolboxService", () => {
  test("seedDefault seeds an org and is idempotent", () => {
    const service = new ToolboxService(new ToolboxRepository());
    const orgId = "org-seed-idempotent";
    const owner = { type: "org", id: orgId } as const;
    const first = service.seedDefault(orgId);
    const second = service.seedDefault(orgId);
    expect(first.ownerType).toBe("org");
    expect(second.id).toBe(first.id);
    expect(service.list(owner)).toHaveLength(1);
  });

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

  test("listEnabled orders oldest-first and excludes disabled", () => {
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
      enabled: true,
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
      enabled: true,
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
      enabled: false,
      createdAt: at(1000),
      updatedAt: at(1000),
    });

    const service = new ToolboxService(repository);
    expect(service.listEnabled(owner).map((c) => c.id)).toEqual([
      "t-first",
      "t-third",
    ]);
  });

  test("ensureDefaults backfills only orgs with zero toolboxes", () => {
    const service = new ToolboxService(new ToolboxRepository());
    const emptyOrg = { type: "org", id: "org-empty-backfill" } as const;
    const nonEmptyOrg = { type: "org", id: "org-nonempty-backfill" } as const;

    service.create(nonEmptyOrg, {
      slug: "custom",
      description: "d",
      build: ["echo hi"],
      paths: ["~/x"],
    });

    service.ensureDefaults([emptyOrg.id, nonEmptyOrg.id]);

    expect(service.list(emptyOrg).map((c) => c.slug)).toEqual(["org-toolbox"]);
    // A deliberately non-default, non-empty org is left untouched — the
    // default is never resurrected once the org has any toolbox (R4).
    expect(service.list(nonEmptyOrg).map((c) => c.slug)).toEqual(["custom"]);
  });

  test("ensureDefaults never auto-seeds users", () => {
    const service = new ToolboxService(new ToolboxRepository());
    const user = { type: "user", id: "user-no-seed" } as const;
    service.ensureDefaults(["some-org"]);
    // Users are bring-your-own — backfill is org-only.
    expect(service.list(user)).toHaveLength(0);
  });
});
