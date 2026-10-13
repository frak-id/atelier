/**
 * The sandbox access rule at the HTTP level: one guard per router gives a
 * non-member a 404 on every `/v1/sandboxes/:id/*` and
 * `/sessions/sandboxes/:id/*` route (incl. the attach socket), and
 * `GET /v1/sandboxes` lists only what the caller may reach.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import type { AuthUser, ControlContainer } from "../control/index.ts";
import { SandboxError, UnauthorizedError } from "../shared/errors.ts";
import { config } from "../shared/lib/config.ts";
import type { ServerContainer } from "./container.ts";

// Auth bypass (mock/local) allows everything; the rule only bites here.
process.env.ATELIER_SERVER_MODE = "production";

const OWNER = "atelier.dev/owner-id";
const ORG = "atelier.dev/org-id";

let dataDir: string;
let control: ControlContainer;
let app: Elysia;
let server: ReturnType<Elysia["listen"]>;
const users: Record<string, AuthUser> = {};
const calls: string[] = [];

/** id → labels of the fake runtime's sandboxes. */
let labels: Record<
  string,
  { metadata: Record<string, string>; annotations: Record<string, string> }
>;

function mkUser(name: string): AuthUser {
  // Unique across test files: `bun test` shares one database per process.
  const u = control.userService.upsertFromLogin(
    `ar-${name}`,
    `ar-${name}`,
    `${name}@x.test`,
    "",
  );
  const user = {
    id: u.id,
    username: `ar-${name}`,
    email: u.email,
    avatarUrl: "",
  };
  users[`tok-${name}`] = user;
  return user;
}

let previousMode: typeof config.server.mode;

beforeAll(async () => {
  // The env line above only counts if this file loads the config first.
  previousMode = config.server.mode;
  config.server.mode = "production";
  dataDir = await mkdtemp(join(tmpdir(), "atelier-access-routes-"));
  process.env.DATA_DIR = dataDir;
  process.env.MIGRATIONS_DIR ??= join(import.meta.dir, "../../drizzle");
  const { initDatabase } = await import("../control/db/client.ts");
  await initDatabase();
  const { createControlContainer } = await import("../control/index.ts");
  const realControl = createControlContainer();
  control = realControl;

  const owner = mkUser("owner");
  const member = mkUser("member");
  const stranger = mkUser("stranger");
  const org = control.organizationService.create("Acme", "ar-acme");
  control.orgMemberService.addMember(org.id, member.id, "member");
  labels = {
    owned: { metadata: { [OWNER]: owner.id }, annotations: { [ORG]: org.id } },
    mine: { metadata: { [OWNER]: member.id, k: "v" }, annotations: {} },
    strays: { metadata: { [OWNER]: stranger.id }, annotations: {} },
    unowned: { metadata: {}, annotations: {} },
  };

  const track = (_: unknown, fn: () => unknown) => fn();
  const runtime = {
    getLabels: (id: string) => labels[id],
    // pause snapshot of `owned`, one of a destroyed sandbox, a shared prebuild
    snapshotOwner: (ref: string) =>
      ({ "snap-owned": "owned", "snap-gone": "gone" })[ref],
    addPort: async (id: string) => {
      calls.push(`port:${id}`);
    },
    addProcess: async (id: string) => {
      calls.push(`process:${id}`);
    },
    processAction: async (id: string) => {
      calls.push(`action:${id}`);
    },
    getSandboxImage: async () => "img",
    captureToolset: async (id: string) => {
      calls.push(`capture:${id}`);
      return { ref: "r" };
    },
    list: (filter: Record<string, string> = {}) =>
      Object.entries(labels)
        .filter(([, l]) =>
          Object.entries(filter).every(([k, v]) => l.metadata[k] === v),
        )
        .map(([id, l]) => ({ id, status: "running", ...l })),
    get: async (id: string) => ({ id, status: "running" }),
    exec: async (id: string) => {
      calls.push(`exec:${id}`);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    destroy: async (id: string) => {
      calls.push(`destroy:${id}`);
    },
    pause: async (id: string) => {
      calls.push(`pause:${id}`);
      return { ref: "r" };
    },
    setAnnotation: (id: string) => {
      calls.push(`rename:${id}`);
    },
    attach: async (id: string) => {
      calls.push(`attach:${id}`);
      return { url: "ws://127.0.0.1:1/none" };
    },
  };
  const jobs = {
    track,
    dispatch: (job: { target: string }) => {
      calls.push(`dispatch:${job.target}`);
      return { id: "job-1" };
    },
    get: (id: string) => ({ id, status: "running" }),
  };
  const sessions = { listSessions: async () => [] };
  const terminal = {
    listSessions: async () => [],
    getOwnedSession: async () => ({}),
    bridgeUrl: async (id: string) => {
      calls.push(`bridge:${id}`);
      return "ws://127.0.0.1:1/none";
    },
  };

  const container = {
    runtime,
    jobs,
    sessions,
    terminal,
    control: {
      ...realControl,
      authService: {
        resolveToken: async (token?: string) => {
          const user = token ? users[token] : undefined;
          if (!user) throw new UnauthorizedError();
          return user;
        },
      },
      canAccessSandbox: realControl.canAccessSandbox,
    },
  } as unknown as ServerContainer;

  const { createV1Routes } = await import("./v1.routes.ts");
  const { createSessionsRoutes } = await import("./sessions.routes.ts");
  const { createControlRoutes } = await import("./control.routes.ts");
  const { createLaunchpadRoutes } = await import("./launchpad.routes.ts");
  app = new Elysia()
    .onError(({ error, set }) => {
      if (error instanceof SandboxError) {
        set.status = error.statusCode;
        return { error: error.code };
      }
    })
    .use(createV1Routes(container))
    .use(createSessionsRoutes(container))
    .use(createControlRoutes(container))
    .use(createLaunchpadRoutes(container)) as unknown as Elysia;
  server = app.listen(0);
});

afterAll(async () => {
  config.server.mode = previousMode;
  server?.stop(true);
  await rm(dataDir, { recursive: true, force: true });
});

function request(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        authorization: `Bearer tok-${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
}

/** Every route that addresses a sandbox id, with a valid body. */
const SANDBOX_ROUTES: [string, string, unknown?][] = [
  ["GET", "/v1/sandboxes/owned"],
  ["PATCH", "/v1/sandboxes/owned", { name: "x" }],
  ["POST", "/v1/sandboxes/owned/pause"],
  ["POST", "/v1/sandboxes/owned/resume", {}],
  ["DELETE", "/v1/sandboxes/owned"],
  ["PATCH", "/v1/sandboxes/owned/files", []],
  ["PATCH", "/v1/sandboxes/owned/env", {}],
  ["POST", "/v1/sandboxes/owned/exec", { command: "id" }],
  ["POST", "/v1/sandboxes/owned/snapshot"],
  ["POST", "/v1/sandboxes/owned/fork", {}],
  [
    "POST",
    "/v1/sandboxes/owned/toolsets/capture",
    { name: "t", paths: ["a"], exclude: [], overrides: [] },
  ],
  ["GET", "/v1/sandboxes/owned/processes/web/logs"],
  ["POST", "/v1/sandboxes/owned/ports", { name: "web", port: 3000 }],
  ["POST", "/v1/sandboxes/owned/processes", { name: "p", command: "true" }],
  ["POST", "/v1/sandboxes/owned/processes/web/start"],
  ["GET", "/sessions/sandboxes/owned/agent/sessions"],
  ["GET", "/sessions/sandboxes/owned/agent/permissions"],
  ["GET", "/sessions/sandboxes/owned/terminal/sessions"],
];

describe("sandbox routes", () => {
  for (const [method, path, body] of SANDBOX_ROUTES) {
    test(`${method} ${path}: a non-member gets 404, owner and member pass`, async () => {
      calls.length = 0;
      const denied = await request("stranger", method, path, body);
      expect(denied.status).toBe(404);
      expect(calls).toEqual([]);
      // Same answer as for an id that does not exist.
      const unknown = await request(
        "stranger",
        method,
        path.replace("owned", "nope"),
        body,
      );
      expect(unknown.status).toBe(404);
      expect(await unknown.json()).toEqual(await denied.json());

      // Not asserting the fork body (it has its own tests): only that the
      // guard let the owner and an org member through.
      for (const who of ["owner", "member"]) {
        const ok = await request(who, method, path, body);
        expect(ok.status).not.toBe(404);
      }
    });
  }

  test("a sandbox with no recorded owner or org is a 404 for everyone", async () => {
    for (const who of ["stranger", "owner", "member"]) {
      const res = await request(who, "GET", "/v1/sandboxes/unowned");
      expect(res.status).toBe(404);
    }
  });

  test("an unknown sandbox is a 404 even for a member", async () => {
    const res = await request("member", "GET", "/v1/sandboxes/nope");
    expect(res.status).toBe(404);
  });

  test("/v1/jobs/:id is not a sandbox route", async () => {
    const res = await request("stranger", "GET", "/v1/jobs/job-1");
    expect(res.status).toBe(200);
  });

  const openSocket = (token: string, path: string) =>
    new Promise<{ opened: boolean; code?: number }>((resolve) => {
      const ws = new WebSocket(
        `ws://localhost:${server.server?.port}${path}`,
        // Bun accepts headers on the client socket.
        { headers: { authorization: `Bearer tok-${token}` } } as never,
      );
      let opened = false;
      ws.onopen = () => {
        opened = true;
      };
      ws.onclose = (e) => resolve({ opened, code: e.code });
      ws.onerror = () => resolve({ opened });
    });

  test("the attach socket refuses a non-member", async () => {
    calls.length = 0;
    await openSocket("stranger", "/v1/sandboxes/owned/attach/web");
    expect(calls).not.toContain("attach:owned");
    await openSocket("owner", "/v1/sandboxes/owned/attach/web");
    expect(calls).toContain("attach:owned");
  });

  test("the terminal socket refuses a non-member and opens no bridge", async () => {
    calls.length = 0;
    const path = "/sessions/sandboxes/owned/terminal/sessions/s1/ws";
    const denied = await openSocket("stranger", path);
    expect(calls).not.toContain("bridge:owned");
    expect(denied.opened && denied.code === 1000).toBe(false);
    await openSocket("owner", path);
    expect(calls).toContain("bridge:owned");
  });

  test("booting from a sandbox-scoped snapshot needs access to its sandbox", async () => {
    const create = (who: string, snapshot: string) =>
      request(who, "POST", "/v1/sandboxes", { source: { snapshot } });
    calls.length = 0;
    expect((await create("stranger", "snap-owned")).status).toBe(404);
    expect((await create("owner", "snap-gone")).status).toBe(404);
    expect(calls).toEqual([]);
    for (const [who, snap] of [
      ["owner", "snap-owned"],
      ["member", "snap-owned"],
      ["stranger", "prebuild-snap"],
    ] as const) {
      expect((await create(who, snap)).status).toBe(202);
    }
  });

  describe("snapshot sources", () => {
    const SCOPED = { snapshot: "snap-owned" };
    const SHARED = { snapshot: "prebuild-snap" };
    const toolbox = (slug: string, source?: unknown) => ({
      slug,
      description: "d",
      build: ["true"],
      paths: [".local"],
      ...(source ? { source } : {}),
    });

    /** Each entry point: stranger 404 on a pause-snapshot source (and no
     * job dispatched), a shared prebuild snapshot passes. */
    const entryPoints: [
      string,
      string,
      string,
      (source: unknown) => unknown,
    ][] = [
      ["POST /v1/prebuilds", "POST", "/v1/prebuilds", (source) => ({ source })],
      [
        "POST /v1/toolsets",
        "POST",
        "/v1/toolsets",
        (source) => ({ name: "ts", build: ["true"], paths: [".x"], source }),
      ],
      [
        "POST /v1/sandboxes (prebuild chain)",
        "POST",
        "/v1/sandboxes",
        (source) => ({ source: { image: "dev-base" }, prebuild: { source } }),
      ],
    ];
    for (const [name, method, path, body] of entryPoints) {
      test(name, async () => {
        calls.length = 0;
        const denied = await request("stranger", method, path, body(SCOPED));
        expect(denied.status).toBe(404);
        expect(calls).toEqual([]);
        const ok = await request("stranger", method, path, body(SHARED));
        expect(ok.status).toBe(202);
      });
    }

    test("POST/PATCH /api/toolboxes", async () => {
      const denied = await request(
        "stranger",
        "POST",
        "/api/toolboxes",
        toolbox("tb-denied", SCOPED),
      );
      expect(denied.status).toBe(404);
      const ok = await request(
        "stranger",
        "POST",
        "/api/toolboxes",
        toolbox("tb-ok", SHARED),
      );
      expect(ok.status).toBe(200);
      const { id } = (await ok.json()) as { id: string };
      const patch = (source: unknown) =>
        request("stranger", "PATCH", `/api/toolboxes/${id}`, { source });
      expect((await patch(SCOPED)).status).toBe(404);
      expect((await patch(SHARED)).status).toBe(200);
      // Clearing the source is not a snapshot.
      expect((await patch(null)).status).toBe(200);
    });

    test("POST/PATCH /api/launchpad/starters", async () => {
      const org = control.organizationService.create("SOrg", "ar-sorg");
      control.orgMemberService.addMember(
        org.id,
        users["tok-stranger"]?.id ?? "",
        "owner",
      );
      const starter = (recipe: unknown) => ({
        title: "t",
        description: "d",
        recipe,
        services: [],
      });
      const path = `/api/launchpad/starters?owner=org:${org.id}`;
      const denied = await request(
        "stranger",
        "POST",
        path,
        starter({ source: SCOPED }),
      );
      expect(denied.status).toBe(404);
      const viaPrebuild = await request(
        "stranger",
        "POST",
        path,
        starter({
          source: { image: "dev-base" },
          prebuild: { source: SCOPED },
        }),
      );
      expect(viaPrebuild.status).toBe(404);
      const ok = await request(
        "stranger",
        "POST",
        path,
        starter({ source: SHARED }),
      );
      expect(ok.status).toBe(200);
      const { id } = (await ok.json()) as { id: string };
      const patch = (recipe: unknown) =>
        request("stranger", "PATCH", `/api/launchpad/starters/${id}`, {
          recipe,
        });
      expect((await patch({ source: SCOPED })).status).toBe(404);
      expect((await patch({ source: SHARED })).status).toBe(200);
    });
  });

  test("an unauthenticated HTTP request is a 401, not skipped", async () => {
    const res = await app.handle(
      new Request("http://localhost/v1/sandboxes/owned"),
    );
    expect(res.status).toBe(401);
  });

  test("auth bypass (local/mock) lets any caller through", async () => {
    const previous = config.server.mode;
    config.server.mode = "local";
    try {
      const res = await request("stranger", "GET", "/v1/sandboxes/owned");
      expect(res.status).toBe(200);
      const list = await request("stranger", "GET", "/v1/sandboxes");
      expect(((await list.json()) as unknown[]).length).toBe(4);
      const snap = await request("stranger", "POST", "/v1/sandboxes", {
        source: { snapshot: "snap-owned" },
      });
      expect(snap.status).toBe(202);
    } finally {
      config.server.mode = previous;
    }
  });

  test("toolbox version capture takes the sandbox from the body: guarded", async () => {
    const tb = control.toolboxService.create(
      { type: "user", id: users["tok-stranger"]?.id ?? "" },
      {
        slug: "mine",
        description: "d",
        build: ["true"],
        paths: [".local"],
      } as never,
    );
    calls.length = 0;
    const path = `/api/toolboxes/${tb.id}/versions/capture`;
    const body = { sandboxId: "owned", description: "d" };
    const denied = await request("stranger", "POST", path, body);
    expect(denied.status).toBe(404);
    expect(calls).toEqual([]);
    // The caller's own sandbox passes the guard.
    const ok = await request("stranger", "POST", path, {
      ...body,
      sandboxId: "strays",
    });
    expect(ok.status).toBe(202);
    expect(calls).toEqual(["dispatch:mine"]);
  });
});

describe("GET /v1/sandboxes", () => {
  async function ids(token: string, query = ""): Promise<string[]> {
    const res = await request(token, "GET", `/v1/sandboxes${query}`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { id: string }[]).map((s) => s.id).sort();
  }

  test("lists only the sandboxes the caller may reach", async () => {
    expect(await ids("stranger")).toEqual(["strays"]);
    expect(await ids("owner")).toEqual(["owned"]);
    expect(await ids("member")).toEqual(["mine", "owned"]);
  });

  test("?owner=me and ?owner=<userId> filter on the creator", async () => {
    expect(await ids("member", "?owner=me")).toEqual(["mine"]);
    expect(await ids("member", `?owner=${users["tok-owner"]?.id}`)).toEqual([
      "owned",
    ]);
    // Asking for someone else's sandboxes never widens access.
    expect(await ids("stranger", `?owner=${users["tok-owner"]?.id}`)).toEqual(
      [],
    );
  });

  test("?owner composes with ?metadata", async () => {
    const meta = (m: object) =>
      `&metadata=${encodeURIComponent(JSON.stringify(m))}`;
    expect(await ids("member", `?owner=me${meta({ k: "v" })}`)).toEqual([
      "mine",
    ]);
    expect(await ids("member", `?owner=me${meta({ k: "other" })}`)).toEqual([]);
    // A metadata filter naming another creator contradicts owner=me.
    expect(
      await ids("member", `?owner=me${meta({ [OWNER]: "someone-else" })}`),
    ).toEqual([]);
    // The adapter's plain metadata filter is unchanged.
    expect(await ids("member", `?${meta({ k: "v" }).slice(1)}`)).toEqual([
      "mine",
    ]);
  });
});
