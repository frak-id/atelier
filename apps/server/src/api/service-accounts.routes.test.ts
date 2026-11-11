/**
 * Service accounts over HTTP: the admin routes, and what a service account's
 * keys can and cannot reach (`mcp` scope on `/mcp` only, no self-management,
 * never an admin without an explicit owner role).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import type { ControlContainer } from "../control/index.ts";
import type { JobRecord } from "../runtime/index.ts";
import { SandboxError } from "../shared/errors.ts";
import type { ServerContainer } from "./container.ts";

process.env.ATELIER_SERVER_MODE = "production";
process.env.ATELIER_DEFAULT_ORG = "sa-routes-team";

let dataDir: string;
let control: ControlContainer;
let handle: (request: Request) => Promise<Response>;
let teamOrgId: string;
let adminJwt: string;
let memberJwt: string;
let bot: { id: string; fullKey: string; mcpKey: string };
/** owner-id → count, what the fake runtime lists. */
const sandboxOwners: string[] = [];
/** Owners of sandbox-create jobs the fake job service reports as active. */
const creatingOwners: string[] = [];

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  },
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "atelier-sa-routes-"));
  process.env.DATA_DIR = dataDir;
  process.env.MIGRATIONS_DIR ??= join(import.meta.dir, "../../drizzle");
  const { initDatabase } = await import("../control/db/client.ts");
  await initDatabase();
  const { createControlContainer, signJwt } = await import(
    "../control/index.ts"
  );
  control = createControlContainer();

  const person = async (id: string) => {
    control.userService.upsertFromLogin(id, id, `${id}@x.test`, "");
    control.defaultOrg.joinDefaultOrg(id);
    return signJwt({ id, username: id, avatarUrl: "", email: `${id}@x.test` });
  };
  adminJwt = await person("sa-admin"); // first in: owner of the default org
  memberJwt = await person("sa-member");
  teamOrgId = control.defaultOrg.defaultOrgId() ?? "";

  const sa = control.serviceAccountService.create({
    name: "routes-bot",
    orgId: teamOrgId,
  });
  const keys = control.serviceAccountService;
  bot = {
    id: sa.id,
    fullKey: keys.createKey(sa.id, { name: "full", scope: "full" }).rawKey,
    mcpKey: keys.createKey(sa.id, { name: "mcp" }).rawKey,
  };

  const runtime = {
    list: () =>
      sandboxOwners.map((owner, i) => ({
        id: `sbx-${i}`,
        status: "running",
        metadata: { "atelier.dev/owner-id": owner },
        annotations: {},
      })),
  };
  const jobs = {
    findActive: (match: (job: JobRecord) => boolean) =>
      creatingOwners
        .map((owner) => ({
          id: "j",
          kind: "sandbox-create" as const,
          status: "running" as const,
          metadata: { owner },
        }))
        .find((job) => match(job as unknown as JobRecord)),
  };
  const container = {
    runtime,
    control,
    jobs,
    idle: {},
    sandboxOps: {},
    toolboxOps: {},
    images: {},
  } as unknown as ServerContainer;
  const { createServiceAccountRoutes } = await import(
    "./service-accounts.routes.ts"
  );
  const { createControlRoutes } = await import("./control.routes.ts");
  const { createMcpRoutes } = await import("./mcp/index.ts");
  const { createV1Routes } = await import("./v1.routes.ts");
  const app = new Elysia()
    .onError(({ error, set }) => {
      if (error instanceof SandboxError) {
        set.status = error.statusCode;
        return { error: error.code, message: error.message };
      }
    })
    .use(createControlRoutes(container))
    .use(createServiceAccountRoutes(container))
    .use(createV1Routes(container))
    .use(createMcpRoutes(container));
  handle = (request) => app.handle(request);
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function call(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

describe("/api/service-accounts", () => {
  test("server admins only: a member, the account's full key and its mcp key are all 403", async () => {
    for (const token of [memberJwt, bot.fullKey, bot.mcpKey]) {
      expect((await call(token, "GET", "/api/service-accounts")).status).toBe(
        403,
      );
      expect(
        (
          await call(token, "POST", "/api/service-accounts", {
            name: "evil",
            orgId: teamOrgId,
          })
        ).status,
      ).toBe(403);
      expect(
        (await call(token, "GET", `/api/service-accounts/${bot.id}/api-keys`))
          .status,
      ).toBe(403);
    }
  });

  test("list shows role, org and the sandboxes it owns", async () => {
    sandboxOwners.push(bot.id, bot.id, "someone");
    const res = await call(adminJwt, "GET", "/api/service-accounts");
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<Record<string, unknown>>;
    const row = list.find((sa) => sa.id === bot.id);
    expect(row).toMatchObject({
      name: "routes-bot",
      username: "routes-bot[bot]",
      role: "member",
      org: { id: teamOrgId, slug: "sa-routes-team" },
      sandboxCount: 2,
      github: { kind: "none" },
    });
    sandboxOwners.length = 0;
  });

  test("create, read, patch and delete", async () => {
    const created = await call(adminJwt, "POST", "/api/service-accounts", {
      name: "http-bot",
      description: "made over http",
      orgId: teamOrgId,
      github: {
        kind: "token",
        token: "ghp_http_secret",
        gitName: "http-bot",
        gitEmail: "http-bot@example.test",
      },
    });
    expect(created.status).toBe(200);
    const sa = (await created.json()) as { id: string };
    expect(JSON.stringify(sa)).not.toContain("ghp_http_secret");
    expect(sa).toMatchObject({
      createdBy: "sa-admin",
      sandboxCount: 0,
      github: { kind: "token", gitName: "http-bot" },
    });

    const patched = await call(
      adminJwt,
      "PATCH",
      `/api/service-accounts/${sa.id}`,
      {
        description: "renamed",
        github: null,
      },
    );
    expect(await patched.json()).toMatchObject({
      description: "renamed",
      github: { kind: "none" },
    });

    const dup = await call(adminJwt, "POST", "/api/service-accounts", {
      name: "http-bot",
      orgId: teamOrgId,
    });
    expect(dup.status).toBe(409);
    expect(
      (await call(adminJwt, "GET", "/api/service-accounts/sa_missing")).status,
    ).toBe(404);

    sandboxOwners.push(sa.id);
    const blocked = await call(
      adminJwt,
      "DELETE",
      `/api/service-accounts/${sa.id}`,
    );
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { message: string }).message).toContain(
      "destroy its 1 sandbox first",
    );
    sandboxOwners.length = 0;

    // A create still resolving its prebuild has no sandbox yet.
    creatingOwners.push(sa.id);
    const creating = await call(
      adminJwt,
      "DELETE",
      `/api/service-accounts/${sa.id}`,
    );
    expect(creating.status).toBe(409);
    expect(((await creating.json()) as { message: string }).message).toContain(
      "still creating",
    );
    creatingOwners.length = 0;
    expect(
      (await call(adminJwt, "DELETE", `/api/service-accounts/${sa.id}`)).status,
    ).toBe(204);
  });

  test("an empty repositories list is refused, not widened", async () => {
    const app = {
      kind: "app",
      appId: "1",
      installationId: "2",
      privateKey: "x",
      repositories: [],
    };
    const res = await call(adminJwt, "POST", "/api/service-accounts", {
      name: "empty-repos",
      orgId: teamOrgId,
      github: app,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(control.serviceAccountService.getByName("empty-repos")).toBe(
      undefined,
    );
  });

  test("keys: the raw key is returned once and works on /mcp only", async () => {
    const res = await call(
      adminJwt,
      "POST",
      `/api/service-accounts/${bot.id}/api-keys`,
      { name: "agent" },
    );
    const { apiKey, rawKey } = (await res.json()) as {
      apiKey: { id: string; scope: string };
      rawKey: string;
    };
    expect(apiKey.scope).toBe("mcp");
    expect(rawKey.startsWith("atl_")).toBe(true);

    const listed = await call(
      adminJwt,
      "GET",
      `/api/service-accounts/${bot.id}/api-keys`,
    );
    expect(await listed.text()).not.toContain(rawKey);

    expect((await call(rawKey, "POST", "/mcp", INITIALIZE)).status).toBe(200);
    expect(
      (
        await call(
          adminJwt,
          "DELETE",
          `/api/service-accounts/${bot.id}/api-keys/${apiKey.id}`,
        )
      ).status,
    ).toBe(204);
    expect((await call(rawKey, "POST", "/mcp", INITIALIZE)).status).toBe(401);
  });

  test("github/check: 400 without an App, GitHub's refusal as a 502", async () => {
    const path = `/api/service-accounts/${bot.id}/github/check`;
    expect((await call(memberJwt, "POST", path)).status).toBe(403);
    expect((await call(adminJwt, "POST", path)).status).toBe(400);

    const { GitHubAppError } = await import("../control/index.ts");
    const credentials = control.gitCredentials;
    const original = credentials.check;
    credentials.check = async () => {
      throw new GitHubAppError(
        "GitHub token request failed (404): Not Found",
        404,
      );
    };
    try {
      const res = await call(adminJwt, "POST", path);
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({
        error: "GITHUB_APP_ERROR",
        message: "GitHub token request failed (404): Not Found",
      });
    } finally {
      credentials.check = original;
    }
  });
});

describe("scoped keys and the lockout", () => {
  test("an mcp key reaches /mcp but not /mcp/admin nor any HTTP route", async () => {
    expect((await call(bot.mcpKey, "POST", "/mcp", INITIALIZE)).status).toBe(
      200,
    );
    const admin = await call(bot.mcpKey, "POST", "/mcp/admin", INITIALIZE);
    expect(admin.status).toBe(403);
    expect(await admin.text()).toContain("only works on the sandbox MCP");
    const http = await call(bot.mcpKey, "GET", "/api/organizations");
    expect(http.status).toBe(403);
    expect(await http.text()).toContain("only works on the sandbox MCP");
  });

  test("a non-admin service account's full key is 403 on /mcp/admin", async () => {
    expect(
      (await call(bot.fullKey, "POST", "/mcp/admin", INITIALIZE)).status,
    ).toBe(403);
    expect((await call(bot.fullKey, "POST", "/mcp", INITIALIZE)).status).toBe(
      200,
    );
  });

  test("a service account can't manage keys, SSH keys or organizations", async () => {
    for (const [method, path, body] of [
      ["GET", "/api/api-keys", undefined],
      ["POST", "/api/api-keys", { name: "mine" }],
      ["DELETE", "/api/api-keys/x", undefined],
      ["GET", "/api/ssh-keys", undefined],
      [
        "POST",
        "/api/ssh-keys",
        { publicKey: "ssh-ed25519 AAAA", name: "k", type: "uploaded" },
      ],
      ["POST", "/api/organizations", { name: "Mine", slug: "mine" }],
    ] as const) {
      const res = await call(bot.fullKey, method, path, body);
      expect(`${method} ${path} ${res.status}`).toBe(`${method} ${path} 403`);
    }
    expect(control.apiKeyService.listByUser(bot.id)).toHaveLength(2);
  });

  test("a person creates an mcp-scoped key for themselves; default is full", async () => {
    const mcp = await call(memberJwt, "POST", "/api/api-keys", {
      name: "ide",
      scope: "mcp",
    });
    expect(
      ((await mcp.json()) as { apiKey: { scope: string } }).apiKey.scope,
    ).toBe("mcp");
    const full = await call(memberJwt, "POST", "/api/api-keys", {
      name: "cli",
    });
    expect(
      ((await full.json()) as { apiKey: { scope: string } }).apiKey.scope,
    ).toBe("full");
  });

  test("a JWT whose subject is a service account is refused", async () => {
    const { signJwt } = await import("../control/index.ts");
    const forged = await signJwt({
      id: bot.id,
      username: "routes-bot[bot]",
      avatarUrl: "",
      email: "x@x.invalid",
    });
    expect((await call(forged, "GET", "/api/organizations")).status).toBe(401);
    expect((await call(forged, "POST", "/mcp", INITIALIZE)).status).toBe(401);
  });

  test("a service account is an admin only with an explicit owner role", async () => {
    const owner = control.serviceAccountService.create({
      name: "owner-bot",
      orgId: teamOrgId,
      role: "owner",
    });
    const { rawKey } = control.serviceAccountService.createKey(owner.id, {
      name: "k",
      scope: "full",
    });
    expect((await call(rawKey, "POST", "/mcp/admin", INITIALIZE)).status).toBe(
      200,
    );
  });
});

describe("shared artefacts are for people", () => {
  const TOOLBOX = { slug: "t", description: "d", build: [], paths: [] };
  const routes: Array<[string, string, unknown]> = [
    ["POST", "/api/toolboxes", TOOLBOX],
    ["PATCH", "/api/toolboxes/tb1", { description: "x" }],
    ["DELETE", "/api/toolboxes/tb1", undefined],
    ["POST", "/api/toolboxes/tb1/versions/v1/publish", undefined],
    ["PUT", "/api/toolboxes/tb1/active-version", { versionId: null }],
    ["POST", "/v1/toolsets", { name: "ts", build: [], paths: [] }],
    [
      "POST",
      "/v1/toolsets/publish",
      { ref: `toolsets/ts@sha256:${"a".repeat(64)}` },
    ],
    ["PATCH", "/v1/prebuilds/snap/surface", {}],
    ["POST", "/v1/images", { seed: "dev-base" }],
    ["POST", "/v1/images/register", { name: "n", ref: "r" }],
  ];

  test("a service account is refused (403), even as an admin with a full key", async () => {
    const sa = control.serviceAccountService.create({
      name: "artefact-bot",
      orgId: teamOrgId,
      role: "owner",
    });
    const { rawKey } = control.serviceAccountService.createKey(sa.id, {
      name: "k",
      scope: "full",
    });
    for (const [method, path, body] of routes) {
      const res = await call(rawKey, method, path, body);
      expect([method, path, res.status]).toEqual([method, path, 403]);
    }
  });

  test("a person who is an admin is not refused by that rule", async () => {
    // The toolbox does not exist: 404, not the service-account 403.
    const res = await call(adminJwt, "DELETE", "/api/toolboxes/tb1");
    expect(res.status).not.toBe(403);
  });
});
