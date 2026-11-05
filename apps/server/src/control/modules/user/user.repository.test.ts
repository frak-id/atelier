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
  test("stores the GitHub token encrypted and reads legacy plaintext", async () => {
    const { getDatabase } = await import("../../db/client.ts");
    const { users } = await import("../../db/schema.ts");
    const { eq } = await import("drizzle-orm");
    control.userService.upsertFromLogin(
      "tok-1",
      "carol",
      "carol@example.test",
      "",
      "gho_plain_token",
    );
    const stored = () =>
      getDatabase()
        .select({ token: users.githubAccessToken })
        .from(users)
        .where(eq(users.id, "tok-1"))
        .get()?.token;
    expect(stored()).toStartWith("enc:");
    expect(stored()).not.toContain("gho_plain_token");
    expect(control.userService.getById("tok-1")?.githubAccessToken).toBe(
      "gho_plain_token",
    );

    // A row written before encryption still reads, and the next login
    // (upsert without a new token) re-encrypts it.
    getDatabase()
      .update(users)
      .set({ githubAccessToken: "gho_legacy" })
      .where(eq(users.id, "tok-1"))
      .run();
    expect(control.userService.getById("tok-1")?.githubAccessToken).toBe(
      "gho_legacy",
    );
    control.userService.upsertFromLogin("tok-1", "carol", "c@x.test", "");
    expect(stored()).toStartWith("enc:");
    expect(control.userService.getById("tok-1")?.githubAccessToken).toBe(
      "gho_legacy",
    );
  });

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
    control.orgMemberService.addMember(team.id, alice.id, "member");
    control.orgMemberService.addMember(personal.id, alice.id, "owner");

    const directory = control.userService.listDirectory();
    const byName = new Map(directory.map((u) => [u.username, u]));

    expect(JSON.stringify(directory)).not.toContain("gho_secret");
    expect(
      byName
        .get("alice")
        ?.organizations.map((o) => [o.slug, o.role, o.personal]),
    ).toEqual([
      ["dir-team", "member", false],
      ["dir-alice", "owner", true],
    ]);
    // A user with no membership still appears.
    expect(byName.get("bob")?.organizations).toEqual([]);
  });
});
