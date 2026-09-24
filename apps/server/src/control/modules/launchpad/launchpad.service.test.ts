import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StarterInput } from "@atelier/spec";
import { NotFoundError, ValidationError } from "../../../shared/errors.ts";
import type * as LaunchpadModule from "./index.ts";

let mod: typeof LaunchpadModule;
let dataDir: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "atelier-launchpad-test-"));
  process.env.DATA_DIR = dataDir;
  // Resolve migrations from this file so the suite passes from any cwd.
  process.env.MIGRATIONS_DIR ??= join(import.meta.dir, "../../../../drizzle");
  const { initDatabase } = await import("../../db/client.ts");
  await initDatabase();
  mod = await import("./index.ts");
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function input(overrides: Partial<StarterInput> = {}): StarterInput {
  return {
    title: "Landing page copy",
    description: "Tweak the marketing site",
    recipe: {
      source: { image: "dev-base" },
      resources: { vcpus: 2, memoryMb: 4096 },
    },
    services: [{ id: "agent", label: "Pi", target: { port: "pi" } }],
    ...overrides,
  };
}

function starters() {
  return new mod.StarterService(new mod.StarterRepository());
}

function workspaces() {
  return new mod.WorkspaceService(new mod.WorkspaceRepository());
}

describe("StarterService", () => {
  test("create defaults to published and round-trips the recipe", () => {
    const service = starters();
    const owner = { type: "org", id: "org-create" } as const;
    const created = service.create(owner, input({ icon: "  " }));
    expect(created.published).toBe(true);
    // A blank icon is "unset", not an empty string.
    expect(created.icon).toBeUndefined();
    expect(service.get(created.id)).toEqual(created);
    expect(service.list(owner).map((s) => s.id)).toEqual([created.id]);
  });

  test("duplicate service ids are rejected on create and update", () => {
    const service = starters();
    const owner = { type: "user", id: "user-dup" } as const;
    const dup = [
      { id: "a", label: "A", target: { port: "web" } },
      { id: "a", label: "B", target: { port: "pi" } },
    ];
    expect(() => service.create(owner, input({ services: dup }))).toThrow(
      ValidationError,
    );
    const ok = service.create(owner, input());
    expect(() => service.update(ok.id, { services: dup })).toThrow(
      ValidationError,
    );
  });

  test("update keeps absent keys and clears icon/guide with null", () => {
    const service = starters();
    const owner = { type: "org", id: "org-update" } as const;
    const created = service.create(
      owner,
      input({ icon: "bot", guide: "Open Pi." }),
    );
    const renamed = service.update(created.id, { title: "  Renamed  " });
    expect(renamed.title).toBe("Renamed");
    expect(renamed.icon).toBe("bot");
    expect(renamed.guide).toBe("Open Pi.");
    const cleared = service.update(created.id, { icon: null, guide: null });
    expect(cleared.icon).toBeUndefined();
    expect(cleared.guide).toBeUndefined();
    // Persisted, not just returned.
    expect(service.get(created.id).guide).toBeUndefined();
  });

  test("the catalog lists published starters of the given owners only", () => {
    const service = starters();
    const org = { type: "org", id: "org-catalog" } as const;
    const other = { type: "org", id: "org-other" } as const;
    const me = { type: "user", id: "user-catalog" } as const;
    const a = service.create(org, input({ title: "A" }));
    service.create(org, input({ title: "Draft", published: false }));
    const b = service.create(me, input({ title: "B" }));
    service.create(other, input({ title: "Not mine" }));
    expect(service.listPublished([org, me]).map((s) => s.id)).toEqual([
      a.id,
      b.id,
    ]);
    expect(service.listPublished([])).toEqual([]);
  });

  test("delete removes it; a missing id is a 404", () => {
    const service = starters();
    const created = service.create({ type: "user", id: "user-del" }, input());
    service.delete(created.id);
    expect(() => service.get(created.id)).toThrow(NotFoundError);
    expect(() => service.delete(created.id)).toThrow(NotFoundError);
  });
});

describe("WorkspaceService", () => {
  const snapshot = {
    starterTitle: "Landing page copy",
    services: [],
  };

  test("a workspace is only visible to its owner", () => {
    const service = workspaces();
    service.create({
      sandboxId: "sb-owner",
      userId: "alice",
      title: "Spring campaign",
      snapshot,
    });
    expect(service.getOwned("sb-owner", "alice").title).toBe("Spring campaign");
    // Someone else's reads as missing, never as forbidden.
    expect(() => service.getOwned("sb-owner", "bob")).toThrow(NotFoundError);
    expect(service.listByUser("bob")).toEqual([]);
  });

  test("rename + describe, and an empty name is refused", () => {
    const service = workspaces();
    service.create({
      sandboxId: "sb-rename",
      userId: "carol",
      title: "Untitled",
      snapshot,
    });
    const updated = service.update("sb-rename", "carol", {
      title: " Pricing page ",
      description: "New tiers for Q4",
    });
    expect(updated.title).toBe("Pricing page");
    expect(updated.description).toBe("New tiers for Q4");
    expect(() => service.update("sb-rename", "carol", { title: " " })).toThrow(
      ValidationError,
    );
    expect(() =>
      service.update("sb-rename", "mallory", { title: "pwned" }),
    ).toThrow(NotFoundError);
  });

  test("most recently touched workspaces come first", async () => {
    const service = workspaces();
    for (const id of ["sb-old", "sb-new"]) {
      service.create({ sandboxId: id, userId: "dave", title: id, snapshot });
      await Bun.sleep(5);
    }
    expect(service.listByUser("dave").map((w) => w.sandboxId)).toEqual([
      "sb-new",
      "sb-old",
    ]);
    service.touch("sb-old");
    expect(service.listByUser("dave")[0]?.sandboxId).toBe("sb-old");
    await Bun.sleep(5);
    service.setJob("sb-new", "job-2");
    const [first] = service.listByUser("dave");
    expect(first?.sandboxId).toBe("sb-new");
    expect(first?.jobId).toBe("job-2");
    service.delete("sb-new");
    expect(service.listByUser("dave").map((w) => w.sandboxId)).toEqual([
      "sb-old",
    ]);
  });
});
