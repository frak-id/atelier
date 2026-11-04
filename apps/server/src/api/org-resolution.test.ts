/** Which org a spawn runs in (`resolveOrgId`). */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlContainer } from "../control/index.ts";
import { ForbiddenError } from "../shared/errors.ts";
import type * as V1Routes from "./v1.routes.ts";

let dataDir: string;
let control: ControlContainer;
let resolveOrgId: typeof V1Routes.resolveOrgId;
const migrationsDir = join(import.meta.dir, "../../drizzle");

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "atelier-org-resolution-"));
  process.env.DATA_DIR = dataDir;
  process.env.MIGRATIONS_DIR ??= migrationsDir;
  const { initDatabase } = await import("../control/db/client.ts");
  await initDatabase();
  const { createControlContainer } = await import("../control/index.ts");
  control = createControlContainer();
  ({ resolveOrgId } = await import("./v1.routes.ts"));
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

/** A user with a personal org who later joined a team org. */
function userWithTeam(n: string) {
  const id = `res-${n}`;
  control.userService.upsertFromLogin(id, `res-${n}`, `${id}@x.test`, "");
  const team = control.organizationService.create(`Team ${n}`, `res-t-${n}`);
  const personal = control.organizationService.create(n, `res-p-${n}`, true);
  // Team membership inserted FIRST: "first row" must not win anymore.
  control.orgMemberService.addMember(team.id, id, "member");
  control.orgMemberService.addMember(personal.id, id, "owner");
  control.userService.setPersonalOrg(id, personal.id);
  return { id, team, personal };
}

describe("resolveOrgId", () => {
  test("defaults to the personal org, whatever the membership order", () => {
    const { id, personal } = userWithTeam("a");
    expect(resolveOrgId(control, id)).toBe(personal.id);
  });

  test("honours an org the caller belongs to, refuses any other", () => {
    const { id, team } = userWithTeam("b");
    const stranger = control.organizationService.create("X", "res-x");
    expect(resolveOrgId(control, id, team.id)).toBe(team.id);
    expect(() => resolveOrgId(control, id, stranger.id)).toThrow(
      ForbiddenError,
    );
  });

  test("an org-less user spawns bare", () => {
    control.userService.upsertFromLogin("res-none", "none", "n@x.test", "");
    expect(resolveOrgId(control, "res-none")).toBeUndefined();
  });
});
