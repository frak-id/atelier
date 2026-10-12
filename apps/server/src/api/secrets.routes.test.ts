/**
 * `/api/secrets` authorization, through the real control routes against a real
 * control DB: org secrets (member lists, owner/admin writes, foreign ids are
 * 404) and global org-less secrets (operator = owner/admin somewhere).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import type { ControlContainer } from "../control/index.ts";
import { SandboxError } from "../shared/errors.ts";
import { config } from "../shared/lib/config.ts";

let dataDir: string;
let previousMode: typeof config.server.mode;
let control: ControlContainer;
let app: Elysia;
let signJwt: typeof import("../control/index.ts").signJwt;

beforeAll(async () => {
  // Real JWT auth: mock/local modes bypass it, and `bun test` shares the
  // config across files.
  previousMode = config.server.mode;
  config.server.mode = "production";
  dataDir = await mkdtemp(join(tmpdir(), "atelier-secrets-routes-"));
  process.env.DATA_DIR = dataDir;
  process.env.MIGRATIONS_DIR ??= join(import.meta.dir, "../../drizzle");
  const { initDatabase } = await import("../control/db/client.ts");
  await initDatabase();
  const controlModule = await import("../control/index.ts");
  signJwt = controlModule.signJwt;
  control = controlModule.createControlContainer();
  const { createControlRoutes } = await import("./control.routes.ts");
  app = new Elysia()
    .onError(({ error, set }) => {
      if (error instanceof SandboxError) {
        set.status = error.statusCode;
        return { error: error.code, message: error.message };
      }
    })
    // Secret routes only touch `control`.
    .use(
      createControlRoutes({ control, jobs: {} } as Parameters<
        typeof createControlRoutes
      >[0]),
    ) as unknown as Elysia;
});

afterAll(async () => {
  config.server.mode = previousMode;
  await rm(dataDir, { recursive: true, force: true });
});

let seq = 0;
function makeUser(memberships: [orgId: string, role: string][] = []) {
  const id = `sec-u${++seq}`;
  control.userService.upsertFromLogin(id, id, `${id}@x.test`, "");
  for (const [orgId, role] of memberships) {
    control.orgMemberService.addMember(
      orgId,
      id,
      role as Parameters<typeof control.orgMemberService.addMember>[2],
    );
  }
  return id;
}

function makeOrg() {
  const n = ++seq;
  return control.organizationService.create(`Org ${n}`, `sec-org-${n}`).id;
}

async function call(
  userId: string,
  method: string,
  path: string,
  body?: unknown,
) {
  const token = await signJwt({
    id: userId,
    username: userId,
    avatarUrl: "",
    email: "",
  });
  return app.handle(
    new Request(`http://localhost/api/secrets${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

describe("org secrets", () => {
  test("any member lists; a non-member is refused", async () => {
    const org = makeOrg();
    await control.secretService.set(org, "K", "v");
    const viewer = makeUser([[org, "viewer"]]);
    const res = await call(viewer, "GET", `?orgId=${org}`);
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { name: string }[]).map((s) => s.name),
    ).toEqual(["K"]);
    const stranger = makeUser();
    expect((await call(stranger, "GET", `?orgId=${org}`)).status).toBe(403);
  });

  test("a non-admin member cannot set or delete; an admin can", async () => {
    const org = makeOrg();
    const member = makeUser([[org, "member"]]);
    const admin = makeUser([[org, "admin"]]);
    const body = { orgId: org, name: "TOKEN", value: "v" };

    expect((await call(member, "POST", "", body)).status).toBe(403);
    const created = await call(admin, "POST", "", body);
    expect(created.status).toBe(200);
    const { id } = (await created.json()) as { id: string };

    expect((await call(member, "DELETE", `/${id}`)).status).toBe(403);
    expect(control.secretService.list(org)).toHaveLength(1);
    expect((await call(admin, "DELETE", `/${id}`)).status).toBe(204);
    expect(control.secretService.list(org)).toHaveLength(0);
  });

  test("a non-member cannot set into an org", async () => {
    const org = makeOrg();
    const stranger = makeUser();
    const res = await call(stranger, "POST", "", {
      orgId: org,
      name: "X",
      value: "v",
    });
    expect(res.status).toBe(403);
    expect(control.secretService.list(org)).toHaveLength(0);
  });

  test("deleting a foreign org's secret is 404, as is an unknown id", async () => {
    const org = makeOrg();
    const secret = await control.secretService.set(org, "KEEP", "v");
    const otherAdmin = makeUser([[makeOrg(), "owner"]]);
    expect((await call(otherAdmin, "DELETE", `/${secret.id}`)).status).toBe(
      404,
    );
    expect((await call(otherAdmin, "DELETE", "/nope")).status).toBe(404);
    expect(control.secretService.list(org)).toHaveLength(1);
  });
});

describe("global (org-less) secrets", () => {
  const body = { name: "GLOBAL_TEST", value: "v" };

  test("are server-managed: refused even for an org owner", async () => {
    const owner = makeUser([[makeOrg(), "owner"]]);
    const global = await control.secretService.set(undefined, "G", "v");

    expect((await call(owner, "GET", "")).status).toBe(403);
    expect((await call(owner, "POST", "", body)).status).toBe(403);
    expect((await call(owner, "DELETE", `/${global.id}`)).status).toBe(403);
    expect(control.secretService.getById(global.id).name).toBe("G");
  });

  test("are manageable when auth is bypassed (mock/local)", async () => {
    const { config } = await import("../shared/lib/config.ts");
    const previous = config.server.mode;
    config.server.mode = "local";
    try {
      const user = makeUser();
      expect((await call(user, "GET", "")).status).toBe(200);
      const created = await call(user, "POST", "", body);
      expect(created.status).toBe(200);
      const { id } = (await created.json()) as { id: string };
      expect((await call(user, "DELETE", `/${id}`)).status).toBe(204);
    } finally {
      config.server.mode = previous;
    }
  });
});
