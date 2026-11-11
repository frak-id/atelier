/**
 * Service accounts: creation rules, updates (org move, role, GitHub
 * credential), config-managed refusals, keys, and the org-member lockout.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../../../shared/errors.ts";
import type { ControlContainer } from "../../index.ts";
import type { ServiceAccountRepository } from "./service-account.repository.ts";

let dataDir: string;
let control: ControlContainer;
let repository: ServiceAccountRepository;
let seq = 0;

const PKCS8 = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const PKCS1 = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs1", format: "pem" })
  .toString();

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "atelier-service-account-test-"));
  process.env.DATA_DIR = dataDir;
  process.env.MIGRATIONS_DIR ??= join(import.meta.dir, "../../../../drizzle");
  process.env.ATELIER_SERVER_MODE = "production";
  process.env.ATELIER_DEFAULT_ORG = "sa-admins";
  const { initDatabase } = await import("../../db/client.ts");
  await initDatabase();
  const { createControlContainer } = await import("../../index.ts");
  const { ServiceAccountRepository } = await import(
    "./service-account.repository.ts"
  );
  control = createControlContainer();
  repository = new ServiceAccountRepository();
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const accounts = () => control.serviceAccountService;

function team(): string {
  seq++;
  return control.organizationService.create(`SA Team ${seq}`, `sa-team-${seq}`)
    .id;
}

function name(): string {
  seq++;
  return `bot-${seq}`;
}

function person(): string {
  seq++;
  const id = `sa-person-${seq}`;
  control.userService.upsertFromLogin(id, id, `${id}@x.test`, "");
  return id;
}

describe("ServiceAccountService.create", () => {
  test("makes a service user with a [bot] username, as a member", () => {
    const orgId = team();
    const n = name();
    const sa = accounts().create({ name: n, orgId, description: " Agent " });
    expect(sa.id.startsWith("sa_")).toBe(true);
    expect(sa.username).toBe(`${n}[bot]`);
    expect(sa.description).toBe("Agent");
    expect(sa.managedBy).toBe("console");
    const user = control.userService.getByIdOrThrow(sa.id);
    expect(user.kind).toBe("service");
    expect(user.email).toBe(`${n}@service-accounts.invalid`);
    expect(control.orgMemberService.getMembership(orgId, sa.id)?.role).toBe(
      "member",
    );
    // Not an admin: no default org membership.
    expect(control.defaultOrg.isServerAdmin(sa.id)).toBe(false);
  });

  test("rejects a bad name, an unknown or personal org, a duplicate", () => {
    const orgId = team();
    for (const bad of ["", "Upper", "-a", "a-", "a_b", "a".repeat(40)]) {
      expect(() => accounts().create({ name: bad, orgId })).toThrow(
        ValidationError,
      );
    }
    expect(() => accounts().create({ name: name(), orgId: "nope" })).toThrow(
      NotFoundError,
    );
    const personal = control.organizationService.create(
      "P",
      `p-${++seq}`,
      true,
    );
    expect(() =>
      accounts().create({ name: name(), orgId: personal.id }),
    ).toThrow(ValidationError);
    const n = name();
    accounts().create({ name: n, orgId });
    expect(() => accounts().create({ name: n, orgId })).toThrow(ConflictError);
  });

  test("an owner role is explicit and only then makes an admin", () => {
    const orgId = team();
    const sa = accounts().create({ name: name(), orgId, role: "owner" });
    expect(control.orgMemberService.getMembership(orgId, sa.id)?.role).toBe(
      "owner",
    );
  });

  test("never returns or stores a secret in clear", () => {
    const sa = accounts().create({
      name: name(),
      orgId: team(),
      github: {
        kind: "token",
        token: "ghp_secret",
        gitName: "n",
        gitEmail: "e@x",
      },
    });
    expect(JSON.stringify(sa)).not.toContain("ghp_secret");
    expect(JSON.stringify(accounts().list())).not.toContain("ghp_secret");
    expect(repository.getGitHub(sa.id)).toMatchObject({ token: "ghp_secret" });
  });
});

describe("ServiceAccountService.update", () => {
  test("moves org (membership follows) and changes role", () => {
    const a = team();
    const b = team();
    const sa = accounts().create({ name: name(), orgId: a });
    // The org keeps another owner, so the account's own role can change.
    control.orgMemberService.addMember(b, person(), "owner");
    const moved = accounts().update(sa.id, { orgId: b, role: "owner" });
    expect(moved.orgId).toBe(b);
    expect(control.orgMemberService.getMembership(a, sa.id)).toBeUndefined();
    expect(control.orgMemberService.getMembership(b, sa.id)?.role).toBe(
      "owner",
    );
    accounts().update(sa.id, { role: "member" });
    expect(control.orgMemberService.getMembership(b, sa.id)?.role).toBe(
      "member",
    );
    expect(() => accounts().update(sa.id, { orgId: "nope" })).toThrow(
      NotFoundError,
    );
    // A failed move leaves the account where it was.
    expect(accounts().get(sa.id).orgId).toBe(b);
  });

  test("GitHub App: validated, secret kept when omitted, removable", () => {
    const sa = accounts().create({ name: name(), orgId: team() });
    const app = {
      kind: "app" as const,
      appId: 123456,
      installationId: "7890",
      privateKey: PKCS1,
      repositories: ["circles-flow"],
      permissions: { contents: "write" },
    };
    const set = accounts().update(sa.id, { github: app });
    expect(set.github).toEqual({
      kind: "app",
      appId: "123456",
      installationId: "7890",
      repositories: ["circles-flow"],
      permissions: { contents: "write" },
    });
    expect(JSON.stringify(set)).not.toContain("PRIVATE KEY");

    // Same kind, no key: the stored one stays.
    accounts().update(sa.id, {
      github: { kind: "app", appId: "1", installationId: "2" },
    });
    expect(repository.getGitHub(sa.id)).toMatchObject({
      kind: "app",
      appId: "1",
      privateKey: PKCS1,
    });

    // Another kind needs its own secret.
    expect(() =>
      accounts().update(sa.id, {
        github: { kind: "token", gitName: "n", gitEmail: "e@x" },
      }),
    ).toThrow(ValidationError);

    accounts().update(sa.id, { github: null });
    expect(accounts().get(sa.id).github).toEqual({ kind: "none" });
    expect(repository.getGitHub(sa.id)).toBeUndefined();
  });

  test("a refused move (last owner of the old org) changes nothing", () => {
    const a = team();
    const b = team();
    const sa = accounts().create({
      name: name(),
      orgId: a,
      role: "owner",
      description: "before",
    });
    expect(() =>
      accounts().update(sa.id, {
        orgId: b,
        description: "after",
        github: {
          kind: "app",
          appId: "1",
          installationId: "2",
          privateKey: PKCS8,
        },
      }),
    ).toThrow();
    expect(accounts().get(sa.id)).toMatchObject({
      orgId: a,
      description: "before",
      github: { kind: "none" },
    });
    expect(control.orgMemberService.getMembership(a, sa.id)?.role).toBe(
      "owner",
    );
    expect(control.orgMemberService.getMembership(b, sa.id)).toBeUndefined();
  });

  test("a role on an account without membership is refused", () => {
    const orgId = team();
    const sa = accounts().create({ name: name(), orgId });
    control.orgMemberService.removeUnchecked(orgId, sa.id);
    expect(() => accounts().update(sa.id, { role: "owner" })).toThrow(
      NotFoundError,
    );
  });

  test("an empty repositories list is refused, not widened", () => {
    const sa = accounts().create({ name: name(), orgId: team() });
    expect(() =>
      accounts().update(sa.id, {
        github: {
          kind: "app",
          appId: "1",
          installationId: "2",
          privateKey: PKCS8,
          repositories: [],
        },
      }),
    ).toThrow("must not be empty");
  });

  test("a kind change without its secret is refused", () => {
    const sa = accounts().create({ name: name(), orgId: team() });
    accounts().update(sa.id, {
      github: { kind: "token", token: "ghp_x", gitName: "n", gitEmail: "e@x" },
    });
    expect(() =>
      accounts().update(sa.id, {
        github: { kind: "app", appId: "1", installationId: "2" },
      }),
    ).toThrow("privateKey is required");
  });

  test("an edit, a removal and a delete tell the credential cache", async () => {
    const { ServiceAccountService } = await import("./index.ts");
    const { UserRepository } = await import("../user/index.ts");
    const events: string[] = [];
    const service = new ServiceAccountService({
      repository,
      organizations: control.organizationService,
      orgMembers: control.orgMemberService,
      apiKeys: control.apiKeyService,
      users: new UserRepository(),
      credentialDropped: (id, change) => events.push(`${id}:${change}`),
    });
    const sa = service.create({ name: name(), orgId: team() });
    service.update(sa.id, { description: "no credential change" });
    expect(events).toEqual([]);
    const github = {
      kind: "token" as const,
      token: "ghp_x",
      gitName: "n",
      gitEmail: "e@x",
    };
    service.update(sa.id, { github });
    service.update(sa.id, { github: null });
    service.delete(sa.id);
    expect(events).toEqual([
      `${sa.id}:edited`,
      `${sa.id}:removed`,
      `${sa.id}:removed`,
    ]);
  });

  test("accepts PKCS#8, rejects junk without echoing it", () => {
    const sa = accounts().create({ name: name(), orgId: team() });
    accounts().update(sa.id, {
      github: {
        kind: "app",
        appId: "1",
        installationId: "2",
        privateKey: PKCS8,
      },
    });
    let message = "";
    try {
      accounts().update(sa.id, {
        github: {
          kind: "app",
          appId: "1",
          installationId: "2",
          privateKey:
            "-----BEGIN PRIVATE KEY-----\nhunter2\n-----END PRIVATE KEY-----",
        },
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("privateKey");
    expect(message).not.toContain("hunter2");
  });

  test("rejects malformed ids, repositories, permissions and tokens", () => {
    const sa = accounts().create({ name: name(), orgId: team() });
    const app = (over: Record<string, unknown>) => ({
      kind: "app" as const,
      appId: "1",
      installationId: "2",
      privateKey: PKCS8,
      ...over,
    });
    for (const bad of [
      app({ appId: "abc" }),
      app({ installationId: "" }),
      app({ repositories: ["owner/repo"] }),
      app({ permissions: { Contents: "write" } }),
      app({ permissions: { contents: "admin" } }),
      { kind: "token" as const, token: " ", gitName: "n", gitEmail: "e" },
      { kind: "token" as const, token: "t", gitName: "", gitEmail: "e" },
      { kind: "token" as const, token: "t", gitName: "n", gitEmail: "" },
    ]) {
      expect(() => accounts().update(sa.id, { github: bad })).toThrow(
        ValidationError,
      );
    }
  });

  test("a config-managed account refuses update and delete, not keys", () => {
    const sa = accounts().create({
      name: name(),
      orgId: team(),
      managedBy: "config",
    });
    expect(() => accounts().update(sa.id, { description: "x" })).toThrow(
      /sandbox\.config\.json/,
    );
    expect(() => accounts().delete(sa.id)).toThrow(ValidationError);
    const { apiKey } = accounts().createKey(sa.id, { name: "ci" });
    expect(
      accounts()
        .listKeys(sa.id)
        .map((k) => k.id),
    ).toEqual([apiKey.id]);
    accounts().revokeKey(sa.id, apiKey.id);
    expect(accounts().listKeys(sa.id)).toEqual([]);
  });
});

describe("ServiceAccountService keys", () => {
  test("keys default to the mcp scope, show the raw key once", () => {
    const sa = accounts().create({ name: name(), orgId: team() });
    const { apiKey, rawKey } = accounts().createKey(sa.id, { name: "agent" });
    expect(rawKey.startsWith("atl_")).toBe(true);
    expect(apiKey.scope).toBe("mcp");
    expect(apiKey.managedBy).toBe("console");
    expect(JSON.stringify(accounts().listKeys(sa.id))).not.toContain(rawKey);
    const full = accounts().createKey(sa.id, { name: "f", scope: "full" });
    expect(full.apiKey.scope).toBe("full");
  });

  test("a past expiry is refused; an unknown account or key is a 404", () => {
    const sa = accounts().create({ name: name(), orgId: team() });
    expect(() =>
      accounts().createKey(sa.id, { name: "k", expiresAt: "2001-01-01" }),
    ).toThrow(ValidationError);
    expect(() => accounts().createKey("sa_nope", { name: "k" })).toThrow(
      NotFoundError,
    );
    expect(() => accounts().revokeKey(sa.id, "nope")).toThrow(NotFoundError);
  });

  test("a non-ISO expiry is stored as an ISO date", () => {
    const sa = accounts().create({ name: name(), orgId: team() });
    const { apiKey } = accounts().createKey(sa.id, {
      name: "k",
      expiresAt: "Dec 1 2099 10:00:00 GMT+0200",
    });
    expect(apiKey.expiresAt).toBe("2099-12-01T08:00:00.000Z");
  });

  test("a personal key's expiry is normalized too, and junk refused", () => {
    const user = person();
    const { apiKey } = control.apiKeyService.create(
      user,
      "mine",
      "Dec 1 2099 10:00:00 GMT+0200",
    );
    expect(apiKey.expiresAt).toBe("2099-12-01T08:00:00.000Z");
    expect(() =>
      control.apiKeyService.create(user, "bad", "not a date"),
    ).toThrow(ValidationError);
  });

  test("a config-managed key can't be revoked", () => {
    const sa = accounts().create({ name: name(), orgId: team() });
    const key = control.apiKeyService.createFromRawKey(
      sa.id,
      "cfg",
      `atl_${"a".repeat(40)}`,
      "mcp",
    );
    expect(() => accounts().revokeKey(sa.id, key.id)).toThrow(ValidationError);
  });

  test("delete removes the user, its keys and its membership", () => {
    const orgId = team();
    const sa = accounts().create({ name: name(), orgId });
    const { rawKey } = accounts().createKey(sa.id, { name: "k" });
    accounts().delete(sa.id);
    expect(() => accounts().get(sa.id)).toThrow(NotFoundError);
    expect(control.userService.getById(sa.id)).toBeUndefined();
    expect(
      control.orgMemberService.getMembership(orgId, sa.id),
    ).toBeUndefined();
    expect(control.apiKeyService.validateKey(rawKey)).toBeNull();
  });
});

describe("a service account in the org-member service", () => {
  test("owners can't invite, re-role or remove it; it can't leave", () => {
    const orgId = team();
    const owner = person();
    control.orgMemberService.addMember(orgId, owner, "owner");
    const sa = accounts().create({ name: name(), orgId });
    const other = team();
    control.orgMemberService.addMember(other, owner, "owner");

    expect(() =>
      control.orgMemberService.inviteMember(other, owner, sa.id),
    ).toThrow(ForbiddenError);
    expect(() =>
      control.orgMemberService.updateRole(orgId, owner, sa.id, "owner"),
    ).toThrow(ForbiddenError);
    expect(() =>
      control.orgMemberService.removeMember(orgId, owner, sa.id),
    ).toThrow(ForbiddenError);
    expect(() =>
      control.orgMemberService.removeMember(orgId, sa.id, sa.id),
    ).toThrow(ForbiddenError);
    expect(control.orgMemberService.getMembership(orgId, sa.id)?.role).toBe(
      "member",
    );
  });
});

describe("sandbox access for service accounts (wired container)", () => {
  test("it reaches its own sandboxes only; people and admins reach them", () => {
    const orgId = team();
    const alice = person();
    const bob = person();
    control.orgMemberService.addMember(orgId, alice, "member");
    control.orgMemberService.addMember(orgId, bob, "owner");
    const sa = accounts().create({ name: name(), orgId });
    const aliceBox = {
      metadata: { "atelier.dev/owner-id": alice },
      annotations: { "atelier.dev/org-id": orgId },
    };
    const botBox = {
      metadata: { "atelier.dev/owner-id": sa.id },
      annotations: { "atelier.dev/org-id": orgId },
    };

    // Alice's sandbox holds her git token: the account never reaches it.
    expect(control.canAccessSandbox(sa.id, aliceBox)).toBe(false);
    expect(control.canAccessSandbox(sa.id, botBox)).toBe(true);
    // The org's people still reach the account's sandbox.
    expect(control.canAccessSandbox(alice, botBox)).toBe(true);
    expect(control.canAccessSandbox(alice, aliceBox)).toBe(true);

    // A server admin outside the org reaches a service account's sandbox,
    // never a person's.
    const admin = person();
    const adminOrg =
      control.organizationService.getBySlug("sa-admins") ??
      control.organizationService.create("sa-admins", "sa-admins");
    control.orgMemberService.addMember(adminOrg.id, admin, "owner");
    expect(control.defaultOrg.isServerAdmin(admin)).toBe(true);
    expect(control.canAccessSandbox(admin, botBox)).toBe(true);
    expect(control.canAccessSandbox(admin, aliceBox)).toBe(false);
  });
});
