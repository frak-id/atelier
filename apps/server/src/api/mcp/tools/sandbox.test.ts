/**
 * The sandbox + system MCP tools through a real MCP client, against a real
 * control DB and a fake runtime: what an agent is allowed to see (no
 * generated credentials), the optional `resources` defaults, and the
 * bounded `exec` / log output.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxSpec } from "@atelier/spec";
import type { AuthUser, ControlContainer } from "../../../control/index.ts";
import type { ServerContainer } from "../../container.ts";
import { connectMcp } from "./mcp.test-support.ts";

let dataDir: string;
let control: ControlContainer;
let registerSandboxTools: typeof import("./sandbox.ts").registerSandboxTools;
let registerSystemTools: typeof import("./system.ts").registerSystemTools;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "atelier-mcp-sandbox-"));
  process.env.DATA_DIR = dataDir;
  process.env.MIGRATIONS_DIR ??= join(import.meta.dir, "../../../../drizzle");
  const { initDatabase } = await import("../../../control/db/client.ts");
  await initDatabase();
  const { createControlContainer } = await import("../../../control/index.ts");
  control = createControlContainer();
  ({ registerSandboxTools } = await import("./sandbox.ts"));
  ({ registerSystemTools } = await import("./system.ts"));
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

const SECRET = "agent-password-s3cret";

const STATE = {
  id: "sbx-1",
  status: "running",
  urls: [
    {
      name: "app",
      url: "https://app-sbx-1.example.test",
      processes: ["web"],
      ready: true,
    },
    { name: "ssh", url: "ssh sbx-1@ssh.example.test -p 2222" },
  ],
  processes: [{ name: "web", running: true, ready: true, primary: true }],
  generated: { agentPassword: SECRET, podIp: "10.1.2.3", sshHostKeys: ["k"] },
  metadata: { "atelier.dev/owner-id": "u-1" },
  annotations: { "atelier.dev/name": "my box", "atelier.dev/org-id": "o-1" },
};

/** A runtime that records what the tools send it. */
function fakeRuntime() {
  const calls = {
    created: [] as SandboxSpec[],
    exec: [] as { id: string; req: Record<string, unknown> }[],
    processActions: [] as string[],
    ports: [] as Record<string, unknown>[],
  };
  let logText = "";
  let patchResults: { path: string; success: boolean; error?: string }[] = [];
  let execResult = { exitCode: 0, stdout: "", stderr: "" };
  const state = { ...STATE, urls: [...STATE.urls] };

  const runtime = {
    create: async (spec: SandboxSpec, opts: { id?: string }) => {
      calls.created.push(spec);
      return {
        id: opts.id ?? "sbx-new",
        urls: STATE.urls,
        generated: STATE.generated,
      };
    },
    list: () => [
      {
        id: "old",
        status: "paused",
        createdAt: "2026-01-01T00:00:00Z",
        annotations: { "atelier.dev/internal": "x" },
      },
      {
        id: "new",
        status: "running",
        createdAt: "2026-02-01T00:00:00Z",
        annotations: { "atelier.dev/name": "fresh" },
        repos: [{ url: "https://github.com/a/b", branch: "main" }],
      },
    ],
    getLabels: () => ({ metadata: {}, annotations: {} }),
    get: async () => state,
    pause: async () => ({ ref: "snap-1", hash: "h".repeat(64), parent: "p" }),
    resume: async () => state,
    snapshot: async () => ({ ref: "snap-2", hash: "h".repeat(64) }),
    destroy: async () => undefined,
    exec: async (id: string, req: Record<string, unknown>) => {
      calls.exec.push({ id, req });
      return execResult;
    },
    processAction: async (_id: string, name: string, action: string) => {
      calls.processActions.push(`${action}:${name}`);
    },
    processLogs: async (
      _id: string,
      name: string,
      offset = 0,
      limit = 1_000_000,
    ) => {
      const content = logText.slice(offset, offset + limit);
      return { name, content, nextOffset: offset + content.length };
    },
    patchFiles: async () => ({ results: patchResults }),
    addPort: async (_id: string, req: Record<string, unknown>) => {
      calls.ports.push(req);
      state.urls = [
        ...STATE.urls,
        { name: String(req.name), url: `https://${req.name}.example.test` },
      ];
    },
    // createSandboxForUser
    prebuildSurface: () => undefined,
    defaultImage: () => "dev-base",
  };
  return {
    runtime,
    calls,
    setLogs: (v: string) => {
      logText = v;
    },
    setPatch: (v: typeof patchResults) => {
      patchResults = v;
    },
    setExec: (v: typeof execResult) => {
      execResult = v;
    },
  };
}

let userSeq = 0;
function newUser(): AuthUser {
  userSeq++;
  const u = control.userService.upsertFromLogin(
    `mcp-sbx-${userSeq}`,
    `sbxuser${userSeq}`,
    `sbxuser${userSeq}@example.test`,
    "",
  );
  return { id: u.id, username: u.username, email: u.email, avatarUrl: "" };
}

async function setup() {
  const fake = fakeRuntime();
  const user = newUser();
  const container = {
    runtime: fake.runtime,
    control,
  } as unknown as ServerContainer;
  const mcp = await connectMcp((server) => {
    registerSandboxTools(server, container, user);
    registerSystemTools(server, container, user);
  });
  cleanups.push(() => mcp.close());
  return { ...mcp, fake, user };
}

describe("create_sandbox", () => {
  test("resources is optional and filled from the server defaults", async () => {
    const { call, fake } = await setup();
    const res = await call("create_sandbox", {
      spec: { source: { image: "dev-base" } },
    });
    expect(res.isError).toBe(false);
    expect(fake.calls.created[0]?.resources).toEqual({
      vcpus: 2,
      memoryMb: 4096,
    });
  });

  test("a partial resources block keeps what was set", async () => {
    const { call, fake } = await setup();
    await call("create_sandbox", {
      spec: {
        source: { image: "dev-base" },
        resources: { vcpus: 6, diskGb: 40 },
      },
    });
    expect(fake.calls.created[0]?.resources).toEqual({
      vcpus: 6,
      memoryMb: 4096,
      diskGb: 40,
    });
  });

  test("returns only the id and openable urls, never the generated section", async () => {
    const { call } = await setup();
    const res = await call("create_sandbox", {
      spec: { source: { image: "dev-base" } },
    });
    expect(res.data).toEqual({
      id: expect.any(String),
      urls: [{ name: "app", url: "https://app-sbx-1.example.test" }],
    });
    expect(res.raw).not.toContain(SECRET);
    expect(res.raw).not.toContain("10.1.2.3");
    expect(res.raw).not.toContain("generated");
    expect(res.raw).not.toContain("ssh ");
  });

  test("a spec without a source is a validation error, not a crash", async () => {
    const { call } = await setup();
    const res = await call("create_sandbox", { spec: {} });
    expect(res.isError).toBe(true);
    expect(res.data.error).toBe("VALIDATION_ERROR");
  });
});

describe("read tools", () => {
  test("get_sandbox without id lists: newest first, name promoted, no annotation map", async () => {
    const { call } = await setup();
    const res = await call("get_sandbox");
    expect(res.data).toEqual([
      {
        id: "new",
        status: "running",
        name: "fresh",
        createdAt: "2026-02-01T00:00:00Z",
        repos: ["https://github.com/a/b"],
      },
      { id: "old", status: "paused", createdAt: "2026-01-01T00:00:00Z" },
    ]);
    expect(res.raw).not.toContain("annotations");

    const paused = await call("get_sandbox", { status: "paused" });
    expect(paused.data.map((s: { id: string }) => s.id)).toEqual(["old"]);
  });

  test("get_sandbox splits ssh out and hides credentials and metadata", async () => {
    const { call } = await setup();
    const res = await call("get_sandbox", { id: "sbx-1" });
    expect(res.data).toEqual({
      id: "sbx-1",
      status: "running",
      name: "my box",
      urls: [
        { name: "app", url: "https://app-sbx-1.example.test", ready: true },
      ],
      ssh: "ssh sbx-1@ssh.example.test -p 2222",
      processes: STATE.processes,
    });
    expect(res.raw).not.toContain(SECRET);

    const verbose = await call("get_sandbox", { id: "sbx-1", verbose: true });
    expect(verbose.data.metadata).toEqual(STATE.metadata);
    expect(verbose.data.urls[0].processes).toEqual(["web"]);
    expect(verbose.raw).not.toContain(SECRET);
  });

  test("get_sandbox rejects params of the other mode", async () => {
    const { call } = await setup();

    const listVerbose = await call("get_sandbox", { verbose: true });
    expect(listVerbose.isError).toBe(true);
    expect(listVerbose.data.error).toBe("VALIDATION_ERROR");
    expect(listVerbose.data.message).toContain("`verbose`");

    const readFilter = await call("get_sandbox", {
      id: "sbx-1",
      status: "running",
    });
    expect(readFilter.isError).toBe(true);
    expect(readFilter.data.error).toBe("VALIDATION_ERROR");
    expect(readFilter.data.message).toContain("`status`");
  });

  test("whoami has no email or user id, and names the default org", async () => {
    const { call, user } = await setup();
    const org = control.organizationService.create(
      `Org ${user.id}`,
      `org-${user.id}`,
      true,
    );
    control.orgMemberService.addMember(org.id, user.id, "owner");
    control.userService.setPersonalOrg(user.id, org.id);

    const res = await call("whoami");
    expect(res.data).toEqual({
      username: user.username,
      orgs: [{ orgId: org.id, name: `Org ${user.id}`, role: "owner" }],
      personalOrgId: org.id,
      defaultOrgId: org.id,
    });
    expect(res.raw).not.toContain("@example.test");
  });
});

describe("sandbox_lifecycle", () => {
  test("pause/snapshot return just the snapshot ref", async () => {
    const { call } = await setup();
    expect(
      (await call("sandbox_lifecycle", { id: "s", action: "pause" })).data,
    ).toEqual({ id: "s", status: "paused", snapshot: "snap-1" });
    expect(
      (await call("sandbox_lifecycle", { id: "s", action: "snapshot" })).data,
    ).toEqual({ id: "s", snapshot: "snap-2" });
  });

  test("resume returns the get_sandbox view, not the generated section", async () => {
    const { call } = await setup();
    const res = await call("sandbox_lifecycle", {
      id: "sbx-1",
      action: "resume",
    });
    expect(res.data.status).toBe("running");
    expect(res.data.ssh).toBe("ssh sbx-1@ssh.example.test -p 2222");
    expect(res.raw).not.toContain(SECRET);
    expect(res.raw).not.toContain("generated");
  });

  test("destroy says so", async () => {
    const { call } = await setup();
    expect(
      (await call("sandbox_lifecycle", { id: "s", action: "destroy" })).data,
    ).toEqual({ id: "s", status: "destroyed" });
  });
});

describe("exec", () => {
  test("a non-zero exit is a result; the default timeout is explicit", async () => {
    const { call, fake } = await setup();
    fake.setExec({ exitCode: 2, stdout: "", stderr: "boom" });
    const res = await call("exec", { id: "s", command: "false" });
    expect(res.isError).toBe(false);
    expect(res.data).toEqual({ exitCode: 2, stdout: "", stderr: "boom" });
    expect(fake.calls.exec[0]?.req.timeoutMs).toBe(30_000);

    await call("exec", { id: "s", command: "x", timeoutMs: 5_000 });
    expect(fake.calls.exec[1]?.req.timeoutMs).toBe(5_000);
  });

  test("output is cut to its tail and flagged", async () => {
    const { call, fake } = await setup();
    fake.setExec({
      exitCode: 0,
      stdout: `${"a".repeat(1_000)}THE-END`,
      stderr: "",
    });
    const res = await call("exec", {
      id: "s",
      command: "x",
      maxOutputChars: 100,
    });
    expect(res.data.truncated).toBe(true);
    expect(res.data.stdout.endsWith("THE-END")).toBe(true);
    expect(res.data.stdout.length).toBeLessThan(200);
  });

  test("out-of-range timeouts never reach the runtime", async () => {
    const { call, fake } = await setup();
    const res = await call("exec", {
      id: "s",
      command: "x",
      timeoutMs: 99_999_999,
    }).then(
      (r) => r.isError,
      () => true,
    );
    expect(res).toBe(true);
    expect(fake.calls.exec).toHaveLength(0);
  });
});

describe("manage_process", () => {
  test("logs return the end of the output, even past one agent chunk", async () => {
    const { call, fake } = await setup();
    // > 1 MB: the agent serves the oldest chunk first.
    fake.setLogs(`${"x".repeat(1_500_000)}LAST-LINE`);
    const res = await call("manage_process", {
      id: "s",
      name: "web",
      action: "logs",
      maxChars: 200,
    });
    expect(res.data.truncated).toBe(true);
    expect(res.data.content.endsWith("LAST-LINE")).toBe(true);
    expect(res.data.content.length).toBeLessThan(300);
  });

  test("short logs come back whole, unflagged", async () => {
    const { call, fake } = await setup();
    fake.setLogs("hello\n");
    const res = await call("manage_process", {
      id: "s",
      name: "web",
      action: "logs",
    });
    expect(res.data).toEqual({
      name: "web",
      content: "hello\n",
      truncated: false,
    });
  });

  test("restart is stop then start", async () => {
    const { call, fake } = await setup();
    const res = await call("manage_process", {
      id: "s",
      name: "web",
      action: "restart",
    });
    expect(res.data).toEqual({ name: "web", status: "restarted" });
    expect(fake.calls.processActions).toEqual(["stop:web", "start:web"]);
  });
});

describe("patch_files", () => {
  const files = [{ path: "/home/dev/a.txt", content: "a" }];

  test("reports success with a count", async () => {
    const { call, fake } = await setup();
    fake.setPatch([{ path: "/home/dev/a.txt", success: true }]);
    const res = await call("patch_files", { id: "s", files });
    expect(res).toMatchObject({
      isError: false,
      data: { written: 1, failed: [] },
    });
  });

  test("a per-file failure is an error result, not {ok:true}", async () => {
    const { call, fake } = await setup();
    fake.setPatch([
      { path: "/ok", success: true },
      { path: "/root/x", success: false, error: "permission denied" },
    ]);
    const res = await call("patch_files", { id: "s", files });
    expect(res.isError).toBe(true);
    expect(res.data).toEqual({
      written: 1,
      failed: [{ path: "/root/x", error: "permission denied" }],
    });
  });
});

describe("expose_port", () => {
  test("returns the url and says public is the default", async () => {
    const { call, fake } = await setup();
    const res = await call("expose_port", { id: "s", name: "api", port: 8080 });
    expect(res.data).toEqual({
      name: "api",
      port: 8080,
      public: true,
      url: "https://api.example.test",
    });
    expect(fake.calls.ports[0]).toMatchObject({ name: "api", port: 8080 });
  });

  test("rejects a port outside 1-65535", async () => {
    const { call, fake } = await setup();
    const rejected = await call("expose_port", {
      id: "s",
      name: "api",
      port: 70_000,
    }).then(
      (r) => r.isError,
      () => true,
    );
    expect(rejected).toBe(true);
    expect(fake.calls.ports).toHaveLength(0);
  });
});
