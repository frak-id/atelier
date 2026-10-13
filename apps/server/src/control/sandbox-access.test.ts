/**
 * The sandbox access rule (`canAccessSandbox`, a pure predicate) and its SSH
 * application: a key reaches a sandbox only when its owner created it or
 * belongs to the org it was created in.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlContainer } from "./index.ts";
import { canAccessSandbox, type SandboxAccessDeps } from "./sandbox-access.ts";

let dataDir: string;
let control: ControlContainer;

beforeAll(async () => {
  // Dynamic imports: the db path is read from DATA_DIR at module load, so it
  // must be set first (same pattern as org-member.service.test.ts).
  dataDir = await mkdtemp(join(tmpdir(), "atelier-sandbox-access-test-"));
  process.env.DATA_DIR = dataDir;
  process.env.MIGRATIONS_DIR ??= join(import.meta.dir, "../../drizzle");
  const { initDatabase } = await import("./db/client.ts");
  await initDatabase();
  const { createControlContainer } = await import("./index.ts");
  control = createControlContainer();
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function userWithKey(name: string): { id: string; key: string } {
  const id = `sa-${name}`;
  control.userService.upsertFromLogin(id, name, `${name}@x.test`, "");
  const key = `ssh-ed25519 ${Buffer.from(name.padEnd(32, "-")).toString("base64")} ${name}`;
  control.sshKeyService.create({
    userId: id,
    username: name,
    publicKey: key,
    name,
    type: "uploaded",
  });
  return { id, key };
}

describe("sandboxSshKeys", () => {
  test("admits the creator and the org's members, nobody else", () => {
    const org = control.organizationService.create("Access", "sa-org");
    const owner = userWithKey("owner");
    const member = userWithKey("member");
    userWithKey("stranger");
    control.orgMemberService.addMember(org.id, member.id, "member");

    expect(
      control
        .sandboxSshKeys({
          metadata: { "atelier.dev/owner-id": owner.id },
          annotations: { "atelier.dev/org-id": org.id },
        })
        .sort(),
    ).toEqual([owner.key, member.key].sort());
    expect(
      control.sandboxSshKeys({
        metadata: { "atelier.dev/owner-id": owner.id },
      }),
    ).toEqual([owner.key]);
    expect(control.sandboxSshKeys({})).toEqual([]);
  });
});

describe("canAccessSandbox", () => {
  const owned = {
    metadata: { "atelier.dev/owner-id": "alice" },
    annotations: { "atelier.dev/org-id": "acme" },
  };
  const deps = (bypassed = false): SandboxAccessDeps => ({
    isAuthBypassed: () => bypassed,
    isOrgMember: (orgId, userId) => orgId === "acme" && userId === "bob",
  });

  test("the owner and an org member are allowed, a non-member is not", () => {
    expect(canAccessSandbox(deps(), "alice", owned)).toBe(true);
    expect(canAccessSandbox(deps(), "bob", owned)).toBe(true);
    expect(canAccessSandbox(deps(), "mallory", owned)).toBe(false);
  });

  test("an owner-id alone (no org) admits only the owner", () => {
    const labels = { metadata: owned.metadata };
    expect(canAccessSandbox(deps(), "alice", labels)).toBe(true);
    expect(canAccessSandbox(deps(), "bob", labels)).toBe(false);
  });

  test("an org annotation alone admits only its members", () => {
    const labels = { annotations: owned.annotations };
    expect(canAccessSandbox(deps(), "bob", labels)).toBe(true);
    expect(canAccessSandbox(deps(), "mallory", labels)).toBe(false);
  });

  test("a sandbox with neither label is reachable by nobody", () => {
    expect(canAccessSandbox(deps(), "mallory", {})).toBe(false);
    expect(
      canAccessSandbox(deps(), "alice", { metadata: {}, annotations: {} }),
    ).toBe(false);
  });

  test("a bypassed-auth (local/mock) server allows everything", () => {
    expect(canAccessSandbox(deps(true), "mallory", owned)).toBe(true);
  });
});
