import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlContainer } from "../../index.ts";

let dataDir: string;
let control: ControlContainer;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "atelier-user-directory-test-"));
  process.env.DATA_DIR = dataDir;
  process.env.MIGRATIONS_DIR ??= join(import.meta.dir, "../../../../drizzle");
  const { initDatabase } = await import("../../db/client.ts");
  await initDatabase();
  const { createControlContainer } = await import("../../index.ts");
  control = createControlContainer();
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("UserService.listDirectory", () => {
  test("lists every user with memberships, never the token", () => {
    const alice = control.userService.upsertFromLogin(
      "dir-1",
      "alice",
      "alice@example.test",
      "",
      "gho_secret",
    );
    control.userService.upsertFromLogin("dir-2", "bob", "bob@example.test", "");
    const team = control.organizationService.create("Team", "dir-team");
    const personal = control.organizationService.create(
      "alice",
      "dir-alice",
      true,
    );
    control.orgMemberService.addMember(team.id, alice.id, "admin");
    control.orgMemberService.addMember(personal.id, alice.id, "owner");

    const directory = control.userService.listDirectory();
    const byName = new Map(directory.map((u) => [u.username, u]));

    expect(JSON.stringify(directory)).not.toContain("gho_secret");
    expect(
      byName
        .get("alice")
        ?.organizations.map((o) => [o.slug, o.role, o.personal]),
    ).toEqual([
      ["dir-team", "admin", false],
      ["dir-alice", "owner", true],
    ]);
    // A user with no membership still appears.
    expect(byName.get("bob")?.organizations).toEqual([]);
  });
});
