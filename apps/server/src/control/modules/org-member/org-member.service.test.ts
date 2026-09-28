/**
 * Org management rules: who may change roles, remove members or leave, and
 * the "an org always keeps an owner" invariant.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConflictError,
  ForbiddenError,
  ValidationError,
} from "../../../shared/errors.ts";
import type { ControlContainer } from "../../index.ts";

let dataDir: string;
let control: ControlContainer;
let seq = 0;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "atelier-org-member-test-"));
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

function user(): string {
  seq++;
  const id = `om-user-${seq}`;
  control.userService.upsertFromLogin(id, `om-${seq}`, `${id}@x.test`, "");
  return id;
}

/** A team org with an owner, an admin and a member. */
function team() {
  seq++;
  const org = control.organizationService.create(`Team ${seq}`, `om-${seq}`);
  const owner = user();
  const admin = user();
  const member = user();
  control.orgMemberService.addMember(org.id, owner, "owner");
  control.orgMemberService.addMember(org.id, admin, "admin");
  control.orgMemberService.addMember(org.id, member, "member");
  const roleOf = (id: string) =>
    control.orgMemberService.getMembership(org.id, id)?.role;
  return { org, owner, admin, member, roleOf };
}

const members = () => control.orgMemberService;

describe("OrgMemberService.updateRole", () => {
  test("owners manage anyone, admins only non-owners", () => {
    const { org, owner, admin, member, roleOf } = team();
    members().updateRole(org.id, admin, member, "viewer");
    expect(roleOf(member)).toBe("viewer");
    expect(() => members().updateRole(org.id, admin, owner, "member")).toThrow(
      ForbiddenError,
    );
    expect(() => members().updateRole(org.id, admin, member, "owner")).toThrow(
      ForbiddenError,
    );
    expect(() => members().updateRole(org.id, member, admin, "viewer")).toThrow(
      ForbiddenError,
    );
    members().updateRole(org.id, owner, admin, "owner");
    expect(roleOf(admin)).toBe("owner");
  });

  test("the last owner can't be demoted", () => {
    const { org, owner } = team();
    expect(() => members().updateRole(org.id, owner, owner, "admin")).toThrow(
      ValidationError,
    );
  });
});

describe("OrgMemberService.inviteMember", () => {
  test("admins add non-owners only; members can't add anyone", () => {
    const { org, owner, admin, member, roleOf } = team();
    const a = user();
    const b = user();
    expect(() => members().inviteMember(org.id, admin, a, "owner")).toThrow(
      ForbiddenError,
    );
    expect(() => members().inviteMember(org.id, member, a, "viewer")).toThrow(
      ForbiddenError,
    );
    expect(roleOf(a)).toBeUndefined();
    members().inviteMember(org.id, admin, a, "admin");
    members().inviteMember(org.id, owner, b, "owner");
    expect([roleOf(a), roleOf(b)]).toEqual(["admin", "owner"]);
  });
});

describe("OrgMemberService.removeMember", () => {
  test("admins remove non-owners; owners remove anyone but the last owner", () => {
    const { org, owner, admin, member, roleOf } = team();
    expect(() => members().removeMember(org.id, admin, owner)).toThrow(
      ForbiddenError,
    );
    expect(() => members().removeMember(org.id, member, admin)).toThrow(
      ForbiddenError,
    );
    members().removeMember(org.id, admin, member);
    expect(roleOf(member)).toBeUndefined();
    members().removeMember(org.id, owner, admin);
    expect(roleOf(admin)).toBeUndefined();
  });

  test("anyone may leave, except the last owner", () => {
    const { org, owner, member, roleOf } = team();
    members().removeMember(org.id, member, member);
    expect(roleOf(member)).toBeUndefined();
    expect(() => members().removeMember(org.id, owner, owner)).toThrow(
      ValidationError,
    );
    // A non-member can't "leave".
    expect(() => members().removeMember(org.id, member, member)).toThrow(
      ForbiddenError,
    );
  });
});

describe("OrganizationService", () => {
  test("rename keeps the id and refuses a taken slug", () => {
    const { org } = team();
    const other = team().org;
    const renamed = control.organizationService.rename(org.id, {
      name: " Renamed ",
      slug: `${org.slug}-x`,
    });
    expect(renamed).toMatchObject({ id: org.id, name: "Renamed" });
    expect(() =>
      control.organizationService.rename(org.id, { slug: other.slug }),
    ).toThrow(ConflictError);
  });

  test("delete removes memberships; a personal org can't be deleted", () => {
    const { org, owner } = team();
    control.organizationService.delete(org.id);
    expect(control.organizationService.getById(org.id)).toBeUndefined();
    expect(members().getByUserId(owner)).toEqual([]);

    const personal = control.organizationService.create("me", "om-me", true);
    expect(() => control.organizationService.delete(personal.id)).toThrow(
      ValidationError,
    );
  });
});
