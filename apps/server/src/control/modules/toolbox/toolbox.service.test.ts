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
  test("seedDefault is idempotent for the same org", () => {
    const service = new ToolboxService(new ToolboxRepository());
    const orgId = "org-seed-idempotent";
    const first = service.seedDefault(orgId);
    const second = service.seedDefault(orgId);
    expect(second.id).toBe(first.id);
    expect(service.list(orgId)).toHaveLength(1);
  });

  test("slug uniqueness is per-org, not global", () => {
    const service = new ToolboxService(new ToolboxRepository());
    const orgA = "org-slug-a";
    const orgB = "org-slug-b";
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

  test("listEnabled orders oldest-first and excludes disabled", () => {
    const repository = new ToolboxRepository();
    const orgId = "org-order";
    const base = Date.now();
    const at = (offsetMs: number) => new Date(base + offsetMs).toISOString();

    repository.create({
      id: "t-third",
      orgId,
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
      orgId,
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
      orgId,
      slug: "b",
      description: "d",
      build: [],
      paths: [],
      enabled: false,
      createdAt: at(1000),
      updatedAt: at(1000),
    });

    const service = new ToolboxService(repository);
    expect(service.listEnabled(orgId).map((c) => c.id)).toEqual([
      "t-first",
      "t-third",
    ]);
  });

  test("ensureDefaults backfills only orgs with zero toolboxes", () => {
    const service = new ToolboxService(new ToolboxRepository());
    const emptyOrg = "org-empty-backfill";
    const nonEmptyOrg = "org-nonempty-backfill";

    service.create(nonEmptyOrg, {
      slug: "custom",
      description: "d",
      build: ["echo hi"],
      paths: ["~/x"],
    });

    service.ensureDefaults([emptyOrg, nonEmptyOrg]);

    expect(service.list(emptyOrg).map((c) => c.slug)).toEqual(["org-toolbox"]);
    // A deliberately non-default, non-empty org is left untouched — the
    // default is never resurrected once the org has any toolbox (R4).
    expect(service.list(nonEmptyOrg).map((c) => c.slug)).toEqual(["custom"]);
  });
});
