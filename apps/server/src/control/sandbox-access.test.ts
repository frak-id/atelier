/**
 * The SSH access rule: a key reaches a sandbox only when its owner created it
 * or belongs to the org it was created in.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlContainer } from "./index.ts";

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
