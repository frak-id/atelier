/**
 * Local (auth-bypassed) mode: everyone is a server admin, except a service
 * account, which is one only as a real owner of the configured default org.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlContainer } from "./index.ts";

let dataDir: string;
let control: ControlContainer;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "atelier-default-org-local-test-"));
  process.env.DATA_DIR = dataDir;
  process.env.MIGRATIONS_DIR ??= join(import.meta.dir, "../../drizzle");
  process.env.ATELIER_SERVER_MODE = "local";
  delete process.env.ATELIER_DEFAULT_ORG;
  const { initDatabase } = await import("./db/client.ts");
  await initDatabase();
  const { createControlContainer } = await import("./index.ts");
  control = createControlContainer();
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

test("a person is an admin, a service account is not, even owning an org", () => {
  control.userService.upsertFromLogin("p1", "p1", "p1@x.test", "");
  const org = control.organizationService.create("Team", "team");
  const sa = control.serviceAccountService.create({
    name: "local-bot",
    orgId: org.id,
    role: "owner",
  });
  expect(control.defaultOrg.isServerAdmin("p1")).toBe(true);
  expect(control.defaultOrg.isServerAdmin(sa.id)).toBe(false);
  expect(() => control.defaultOrg.requireServerAdmin(sa.id)).toThrow();
});
