/**
 * Config-declared service accounts: creation, adoption, drift correction,
 * env key rotation, and the hand-back of an account that is no longer
 * declared.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServiceAccountConfig } from "../config/config.schema.ts";
import type { ControlContainer } from "./index.ts";
import type { ServiceAccountRepository } from "./modules/service-account/index.ts";

let dataDir: string;
let control: ControlContainer;
let repository: ServiceAccountRepository;
let reconcile: () => void;
let seq = 0;

const env: Record<string, string> = {};
const files: Record<string, string> = {};
let declared: ServiceAccountConfig[] = [];

const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const key = (c: string) => `atl_${c.repeat(40)}`;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "atelier-sa-config-test-"));
  process.env.DATA_DIR = dataDir;
  process.env.MIGRATIONS_DIR ??= join(import.meta.dir, "../../drizzle");
  process.env.ATELIER_SERVER_MODE = "production";
  process.env.ATELIER_DEFAULT_ORG = "sa-config-team";
  const { initDatabase } = await import("./db/client.ts");
  await initDatabase();
  const { createControlContainer } = await import("./index.ts");
  const { ServiceAccountRepository } = await import(
    "./modules/service-account/index.ts"
  );
  const { createServiceAccountReconciler } = await import(
    "./service-account-config.ts"
  );
  control = createControlContainer();
  repository = new ServiceAccountRepository();
  const reconciler = createServiceAccountReconciler({
    declared: () => declared,
    accounts: control.serviceAccountService,
    repository,
    organizations: control.organizationService,
    orgMembers: control.orgMemberService,
    apiKeys: control.apiKeyService,
    readEnv: (name) => env[name],
    readFile: (path) => {
      const content = files[path];
      if (content === undefined) throw new Error("ENOENT");
      return content;
    },
  });
  reconcile = () => reconciler.reconcile();
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

/** A fresh team org and a unique account name. */
function fresh() {
  seq++;
  const slug = `sa-cfg-${seq}`;
  const org = control.organizationService.create(slug, slug);
  return { slug, org, name: `cfg-bot-${seq}`, envName: `CFG_KEY_${seq}` };
}

const keysOf = (id: string) => control.apiKeyService.listByUser(id);

describe("reconcile", () => {
  test("creates the account, its credential and its one config key", () => {
    const { slug, org, name, envName } = fresh();
    env[envName] = key("a");
    env[`${envName}_PEM`] = PEM;
    declared = [
      {
        name,
        org: slug,
        description: "declared",
        github: {
          appId: 123,
          installationId: "456",
          privateKeyEnv: `${envName}_PEM`,
          repositories: ["repo-a"],
          permissions: { contents: "write" },
        },
        apiKey: { env: envName },
      },
    ];
    reconcile();

    const sa = control.serviceAccountService.getByName(name);
    expect(sa).toMatchObject({
      managedBy: "config",
      description: "declared",
      orgId: org.id,
      github: { kind: "app", appId: "123", installationId: "456" },
    });
    expect(control.serviceAccountService.roleOf(sa as never)).toBe("member");
    expect(repository.getGitHub(sa?.id ?? "")).toMatchObject({
      privateKey: PEM,
    });
    const keys = keysOf(sa?.id ?? "");
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ managedBy: "config", scope: "mcp" });
    expect(control.apiKeyService.validateKey(key("a"))?.userId).toBe(sa?.id);

    // Idempotent: nothing is rewritten or duplicated.
    const before = keys[0]?.id;
    reconcile();
    expect(keysOf(sa?.id ?? "").map((k) => k.id)).toEqual([before ?? ""]);
  });

  test("a second run writes nothing, even with a padded description", async () => {
    const { slug, name, envName } = fresh();
    env[envName] = key("f");
    env[`${envName}_PEM`] = PEM;
    declared = [
      {
        name,
        org: slug,
        description: "  padded  ",
        role: "owner",
        github: {
          appId: 1,
          installationId: 2,
          privateKeyEnv: `${envName}_PEM`,
        },
        apiKey: { env: envName },
      },
    ];
    reconcile();
    const id = control.serviceAccountService.getByName(name)?.id ?? "";
    const rowBefore = repository.getById(id);
    const keysBefore = keysOf(id);
    expect(rowBefore?.description).toBe("padded");

    await Bun.sleep(5); // a write would move updatedAt
    reconcile();
    expect(repository.getById(id)?.updatedAt).toBe(rowBefore?.updatedAt ?? "");
    expect(keysOf(id)).toEqual(keysBefore);
  });

  test("a rotated env key replaces the old one", () => {
    const { slug, name, envName } = fresh();
    env[envName] = key("b");
    declared = [{ name, org: slug, apiKey: { env: envName } }];
    reconcile();
    const id = control.serviceAccountService.getByName(name)?.id ?? "";
    env[envName] = key("c");
    reconcile();
    expect(keysOf(id)).toHaveLength(1);
    expect(control.apiKeyService.validateKey(key("b"))).toBeNull();
    expect(control.apiKeyService.validateKey(key("c"))?.userId).toBe(id);
  });

  test("a changed scope re-registers the key", () => {
    const { slug, name, envName } = fresh();
    env[envName] = key("d");
    declared = [{ name, org: slug, apiKey: { env: envName } }];
    reconcile();
    declared = [{ name, org: slug, apiKey: { env: envName, scope: "full" } }];
    reconcile();
    const id = control.serviceAccountService.getByName(name)?.id ?? "";
    expect(keysOf(id).map((k) => k.scope)).toEqual(["full"]);
  });

  test("a key already owned by another user is skipped, never moved", () => {
    const { slug, name, envName } = fresh();
    const other = control.serviceAccountService.create({
      name: `${name}-other`,
      orgId: fresh().org.id,
    });
    env[envName] = key("e");
    control.apiKeyService.createFromRawKey(other.id, "x", key("e"), "mcp");
    declared = [{ name, org: slug, apiKey: { env: envName } }];
    reconcile();
    const id = control.serviceAccountService.getByName(name)?.id ?? "";
    expect(keysOf(id)).toEqual([]);
    expect(control.apiKeyService.validateKey(key("e"))?.userId).toBe(other.id);
  });

  test("an invalid or missing key/secret keeps the current state", () => {
    const { slug, name, envName } = fresh();
    env[envName] = key("f");
    declared = [
      {
        name,
        org: slug,
        github: { tokenEnv: `${envName}_TOKEN`, gitName: "n", gitEmail: "e@x" },
        apiKey: { env: envName },
      },
    ];
    env[`${envName}_TOKEN`] = "ghp_one";
    reconcile();
    const id = control.serviceAccountService.getByName(name)?.id ?? "";
    expect(repository.getGitHub(id)).toMatchObject({ token: "ghp_one" });

    delete env[`${envName}_TOKEN`];
    env[envName] = "not-a-key";
    reconcile();
    expect(repository.getGitHub(id)).toMatchObject({ token: "ghp_one" });
    expect(control.apiKeyService.validateKey(key("f"))?.userId).toBe(id);

    // The token changes: written; same value again: untouched.
    env[`${envName}_TOKEN`] = "ghp_two";
    reconcile();
    expect(repository.getGitHub(id)).toMatchObject({ token: "ghp_two" });
  });

  test("reads an App private key from a file", () => {
    const { slug, name } = fresh();
    files["/etc/atelier/bot.pem"] = PEM;
    declared = [
      {
        name,
        org: slug,
        github: {
          appId: "1",
          installationId: "2",
          privateKeyFile: "/etc/atelier/bot.pem",
        },
      },
    ];
    reconcile();
    const id = control.serviceAccountService.getByName(name)?.id ?? "";
    expect(repository.getGitHub(id)).toMatchObject({ kind: "app" });
  });

  test("a missing org is skipped until it exists", () => {
    seq++;
    const name = `cfg-late-${seq}`;
    const slug = `sa-cfg-late-${seq}`;
    declared = [{ name, org: slug }];
    reconcile();
    expect(control.serviceAccountService.getByName(name)).toBeUndefined();
    control.organizationService.create(slug, slug);
    reconcile();
    expect(control.serviceAccountService.getByName(name)).toBeDefined();
  });

  test("adopts a console account of the same name and fixes drift", () => {
    const { slug, org, name } = fresh();
    const other = fresh();
    // The old org keeps an owner, so the account can leave it.
    control.userService.upsertFromLogin("cfg-owner", "cfg-owner", "o@x", "");
    control.orgMemberService.addMember(other.org.id, "cfg-owner", "owner");
    const sa = control.serviceAccountService.create({
      name,
      orgId: other.org.id,
      role: "owner",
      description: "old",
    });
    declared = [{ name, org: slug, role: "member", description: "new" }];
    reconcile();
    const now = control.serviceAccountService.get(sa.id);
    expect(now).toMatchObject({
      managedBy: "config",
      orgId: org.id,
      description: "new",
    });
    expect(control.orgMemberService.getMembership(org.id, sa.id)?.role).toBe(
      "member",
    );
    expect(
      control.orgMemberService.getMembership(other.org.id, sa.id),
    ).toBeUndefined();
  });

  test("an account that is no longer declared goes back to the console, without its config key", () => {
    const { slug, name, envName } = fresh();
    env[envName] = key("g");
    declared = [{ name, org: slug, apiKey: { env: envName } }];
    reconcile();
    const id = control.serviceAccountService.getByName(name)?.id ?? "";
    const consoleKey = control.serviceAccountService.createKey(id, {
      name: "by-admin",
    });

    declared = [];
    reconcile();
    expect(control.serviceAccountService.get(id).managedBy).toBe("console");
    expect(keysOf(id).map((k) => k.id)).toEqual([consoleKey.apiKey.id]);
    expect(control.apiKeyService.validateKey(key("g"))).toBeNull();
  });

  test("dropping the github block removes the credential", () => {
    const { slug, name, envName } = fresh();
    env[envName] = "ghp_x";
    declared = [
      {
        name,
        org: slug,
        github: { tokenEnv: envName, gitName: "n", gitEmail: "e@x" },
      },
    ];
    reconcile();
    const id = control.serviceAccountService.getByName(name)?.id ?? "";
    expect(repository.getGitHub(id)).toBeDefined();
    declared = [{ name, org: slug }];
    reconcile();
    expect(repository.getGitHub(id)).toBeUndefined();
  });
});
