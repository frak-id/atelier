/**
 * `auth.defaultOrg`: auto-join on first login and the server-admin rule
 * (owners of the default org).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForbiddenError } from "../shared/errors.ts";
import type { ControlContainer } from "./index.ts";

let dataDir: string;
let control: ControlContainer;
let seq = 0;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "atelier-default-org-test-"));
  process.env.DATA_DIR = dataDir;
  process.env.MIGRATIONS_DIR ??= join(import.meta.dir, "../../drizzle");
  process.env.ATELIER_SERVER_MODE = "production";
  process.env.ATELIER_DEFAULT_ORG = "team";
  const { initDatabase } = await import("./db/client.ts");
  await initDatabase();
  const { createControlContainer } = await import("./index.ts");
  control = createControlContainer();
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function user(): string {
  seq++;
  const id = `do-user-${seq}`;
  control.userService.upsertFromLogin(id, id, `${id}@x.test`, "");
  return id;
}

describe("default org", () => {
  test("the first login creates the team org and owns it; later ones join as members", () => {
    const first = user();
    const second = user();
    control.defaultOrg.joinDefaultOrg(first);
    control.defaultOrg.joinDefaultOrg(second);

    const team = control.organizationService.getBySlug("team");
    expect(team?.personal).toBe(false);
    expect(control.defaultOrg.defaultOrgId()).toBe(team?.id);
    const roleOf = (id: string) =>
      control.orgMemberService.getMembership(team?.id ?? "", id)?.role;
    expect(roleOf(first)).toBe("owner");
    expect(roleOf(second)).toBe("member");

    // Joining twice is a no-op.
    control.defaultOrg.joinDefaultOrg(second);
    expect(roleOf(second)).toBe("member");
  });

  test("server admins are the default org's owners", () => {
    const owner = user();
    const member = user();
    const outsider = user();
    control.defaultOrg.joinDefaultOrg(member);
    const team = control.organizationService.getBySlug("team");
    control.orgMemberService.addMember(team?.id ?? "", owner, "owner");

    expect(control.defaultOrg.isServerAdmin(owner)).toBe(true);
    expect(control.defaultOrg.isServerAdmin(member)).toBe(false);
    expect(control.defaultOrg.isServerAdmin(outsider)).toBe(false);
    expect(() => control.defaultOrg.requireServerAdmin(member)).toThrow(
      ForbiddenError,
    );
    expect(() => control.defaultOrg.requireServerAdmin(owner)).not.toThrow();
  });
});
