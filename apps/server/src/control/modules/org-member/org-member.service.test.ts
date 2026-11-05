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

/** A team org with two owners and a member. */
function team() {
  seq++;
  const org = control.organizationService.create(`Team ${seq}`, `om-${seq}`);
  const owner = user();
  const coOwner = user();
  const member = user();
  control.orgMemberService.addMember(org.id, owner, "owner");
  control.orgMemberService.addMember(org.id, coOwner, "owner");
  control.orgMemberService.addMember(org.id, member, "member");
  const roleOf = (id: string) =>
    control.orgMemberService.getMembership(org.id, id)?.role;
  return { org, owner, coOwner, member, roleOf };
}

const members = () => control.orgMemberService;

describe("OrgMemberService.updateRole", () => {
  test("owners change roles; members can't", () => {
    const { org, owner, coOwner, member, roleOf } = team();
    expect(() =>
      members().updateRole(org.id, member, coOwner, "member"),
    ).toThrow(ForbiddenError);
    members().updateRole(org.id, owner, member, "owner");
    expect(roleOf(member)).toBe("owner");
    members().updateRole(org.id, owner, coOwner, "member");
    expect(roleOf(coOwner)).toBe("member");
  });

  test("the last owner can't be demoted", () => {
    const { org, owner, coOwner } = team();
    members().removeMember(org.id, owner, coOwner);
    expect(() => members().updateRole(org.id, owner, owner, "member")).toThrow(
      ValidationError,
    );
  });
});

describe("OrgMemberService.inviteMember", () => {
  test("owners add members and owners; members can't add anyone", () => {
    const { org, owner, member, roleOf } = team();
    const a = user();
    const b = user();
    expect(() => members().inviteMember(org.id, member, a, "member")).toThrow(
      ForbiddenError,
    );
    expect(roleOf(a)).toBeUndefined();
    members().inviteMember(org.id, owner, a);
    members().inviteMember(org.id, owner, b, "owner");
    expect([roleOf(a), roleOf(b)]).toEqual(["member", "owner"]);
  });
});

describe("OrgMemberService.removeMember", () => {
  test("owners remove anyone but the last owner; members remove nobody", () => {
    const { org, owner, coOwner, member, roleOf } = team();
    expect(() => members().removeMember(org.id, member, coOwner)).toThrow(
      ForbiddenError,
    );
    members().removeMember(org.id, owner, member);
    expect(roleOf(member)).toBeUndefined();
    members().removeMember(org.id, owner, coOwner);
    expect(roleOf(coOwner)).toBeUndefined();
    expect(() => members().removeMember(org.id, owner, owner)).toThrow(
      ValidationError,
    );
  });

  test("anyone may leave, except the last owner", () => {
    const { org, owner, coOwner, member, roleOf } = team();
    members().removeMember(org.id, member, member);
    expect(roleOf(member)).toBeUndefined();
    members().removeMember(org.id, coOwner, coOwner);
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
