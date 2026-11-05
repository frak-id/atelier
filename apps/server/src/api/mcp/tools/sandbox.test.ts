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
import { buildGitAttributionFiles } from "../../../shared/lib/git-attribution.ts";
import type { ServerContainer } from "../../container.ts";
import { connectMcp } from "./mcp.test-support.ts";

let dataDir: string;
let control: ControlContainer;
let registerSandboxTools: typeof import("./sandbox.ts").registerSandboxTools;
let registerSystemTools: typeof import("./system.ts").registerSystemTools;
let JobService: typeof import("../../../runtime/jobs.service.ts").JobService;
let SandboxOps: typeof import("../../app/sandbox-ops.ts").SandboxOps;
let ToolboxOps: typeof import("../../app/toolbox-ops.ts").ToolboxOps;

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
  ({ JobService } = await import("../../../runtime/jobs.service.ts"));
  ({ SandboxOps } = await import("../../app/sandbox-ops.ts"));
  ({ ToolboxOps } = await import("../../app/toolbox-ops.ts"));
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

/** A spec as stored for sandbox owner "alice": her git files + owner tags. */
const STORED_SOURCE_SPEC: SandboxSpec = {
  source: { image: "dev-base" },
  resources: { vcpus: 1, memoryMb: 512 },
  files: buildGitAttributionFiles({
    identity: { name: "alice", email: "alice@alice.test" },
    githubToken: "ghp_alice",
  }),
  annotations: {
    "atelier.dev/owner": "alice",
    "atelier.dev/owner-email": "alice@alice.test",
    "atelier.dev/org-id": "org-1",
  },
  metadata: { "atelier.dev/owner-id": "u-alice" },
};

/** A runtime that records what the tools send it. */
function fakeRuntime() {
  const calls = {
    created: [] as SandboxSpec[],
    forked: [] as { sourceId: string; name?: string; spec: SandboxSpec }[],
    exec: [] as { id: string; req: Record<string, unknown> }[],
    processActions: [] as string[],
    ports: [] as Record<string, unknown>[],
    baked: [] as Record<string, unknown>[],
    keepAwake: [] as (string | null)[],
  };
  let bakes: unknown[] = [];
  let logText = "";
  let patchResults: { path: string; success: boolean; error?: string }[] = [];
  let execResult = { exitCode: 0, stdout: "", stderr: "" };
  let status = "running";
  let createGate: Promise<void> | undefined;
  const state = { ...STATE, urls: [...STATE.urls] };

  const runtime = {
    create: async (spec: SandboxSpec, opts: { id?: string }) => {
      await createGate;
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
    getStatus: () => status,
    assertSnapshottable: () => undefined,
    get: async () => state,
    pause: async () => ({ ref: "snap-1", hash: "h".repeat(64), parent: "p" }),
    resume: async () => state,
    snapshot: async () => ({ ref: "snap-2", hash: "h".repeat(64) }),
    // Runs the caller's derive step over a spec stored for another owner.
    fork: async (
      sourceId: string,
      f: {
        derive: (spec: SandboxSpec) => { spec: SandboxSpec };
        name?: string;
      },
      opts: { id?: string },
    ) => {
      calls.forked.push({
        sourceId,
        name: f.name,
        spec: f.derive(STORED_SOURCE_SPEC).spec,
      });
      return {
        id: opts.id ?? "sbx-copy",
        urls: STATE.urls,
        generated: STATE.generated,
      };
    },
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
    listPrebuilds: () => bakes,
    prebuild: async (spec: Record<string, unknown>) => {
      calls.baked.push(spec);
      return { ref: "snap-fresh" };
    },
    defaultImage: () => "dev-base",
  };
  const idle = {
    decorate: <T>(rows: T[]) => rows,
    summary: () => undefined,
    setKeepAwake: (_id: string, value: string | null) => {
      calls.keepAwake.push(value);
      return value ?? undefined;
    },
  };
  return {
    runtime,
    idle,
    calls,
    setBakes: (v: unknown[]) => {
      bakes = v;
    },
    setLogs: (v: string) => {
      logText = v;
    },
    setPatch: (v: typeof patchResults) => {
      patchResults = v;
    },
    setExec: (v: typeof execResult) => {
      execResult = v;
    },
    setStatus: (v: string) => {
      status = v;
    },
    /** Hold every `runtime.create` until the returned release is called. */
    holdCreate: () => {
      let release = () => {};
      createGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}

/** Wait until every job in the feed has settled (the tools return early). */
async function settle(jobs: { list(): { status: string }[] }) {
  const open = () =>
    jobs.list().some((j) => j.status === "running" || j.status === "queued");
  for (let i = 0; i < 400 && open(); i++) await Bun.sleep(5);
  expect(open()).toBe(false);
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
  // Ownerless sandboxes are closed to everyone (control/sandbox-access.ts):
  // every sandbox of the fake belongs to the caller.
  const owned = { "atelier.dev/owner-id": user.id };
  const listed = fake.runtime.list;
  Object.assign(fake.runtime, {
    getLabels: () => ({ metadata: owned, annotations: {} }),
    list: () => listed().map((row) => ({ ...row, metadata: owned })),
  });
  const jobs = new JobService();
  const toolboxOps = new ToolboxOps({
    runtime: fake.runtime,
    control,
    jobs,
  } as never);
  const sandboxOps = new SandboxOps({
    runtime: fake.runtime,
    control,
    jobs,
    toolboxes: toolboxOps,
    idle: fake.idle,
  } as never);
  const container = {
    runtime: fake.runtime,
    control,
    idle: fake.idle,
    jobs,
    sandboxOps,
    toolboxOps,
  } as unknown as ServerContainer;
  const mcp = await connectMcp((server) => {
    registerSandboxTools(server, container, user);
    registerSystemTools(server, container, user);
  });
  cleanups.push(() => mcp.close());
  return { ...mcp, fake, user, jobs };
}

describe("create_sandbox", () => {
  test("resources is optional and filled from the server defaults", async () => {
    const { call, fake, jobs } = await setup();
    const res = await call("create_sandbox", {
      spec: { source: { image: "dev-base" } },
    });
    expect(res.isError).toBe(false);
    await settle(jobs);
    expect(fake.calls.created[0]?.resources).toEqual({
      vcpus: 2,
      memoryMb: 4096,
    });
  });

  test("`repo` reuses a bake of it, else bakes one on the image", async () => {
    const { call, fake, jobs } = await setup();
    const repo = { url: "https://github.com/acme/app", branch: "dev" };
    fake.setBakes([
      {
        ref: "snap-cached",
        spec: {
          source: { image: "dev-base" },
          repos: [{ url: "git@github.com:acme/app.git", branch: "dev" }],
        },
      },
    ]);
    const hit = await call("create_sandbox", {
      spec: { source: { image: "dev-base" } },
      repo,
    });
    expect(hit.isError).toBe(false);
    await settle(jobs);
    expect(fake.calls.baked).toHaveLength(0);
    expect(fake.calls.created[0]?.source).toEqual({ snapshot: "snap-cached" });
    expect(fake.calls.created[0]).not.toHaveProperty("repo");

    fake.setBakes([]);
    await call("create_sandbox", {
      spec: { source: { image: "dev-base" } },
      repo,
    });
    await settle(jobs);
    expect(fake.calls.baked[0]).toMatchObject({
      source: { image: "dev-base" },
      repos: [{ url: repo.url, branch: "dev", clonePath: "app" }],
    });
    expect(fake.calls.created[1]?.source).toEqual({ snapshot: "snap-fresh" });
  });

  test("`repo` with a prebuild is refused", async () => {
    const { call, fake } = await setup();
    const res = await call("create_sandbox", {
      spec: { source: { image: "dev-base" } },
      repo: { url: "https://github.com/acme/app" },
      prebuild: { source: { image: "dev-base" } },
    });
    expect(res.isError).toBe(true);
    expect(fake.calls.created).toHaveLength(0);
  });

  test("a partial resources block keeps what was set", async () => {
    const { call, fake, jobs } = await setup();
    await call("create_sandbox", {
      spec: {
        source: { image: "dev-base" },
        resources: { vcpus: 6, diskGb: 40 },
      },
    });
    await settle(jobs);
    expect(fake.calls.created[0]?.resources).toEqual({
      vcpus: 6,
      memoryMb: 4096,
      diskGb: 40,
    });
  });

  test("returns at once with the id and a job, never the generated section", async () => {
    const { call, fake, jobs } = await setup();
    const release = fake.holdCreate();
    const res = await call("create_sandbox", {
      spec: { source: { image: "dev-base" } },
    });
    expect(res.data).toEqual({
      id: expect.any(String),
      status: "creating",
      jobId: expect.any(String),
    });
    expect(jobs.get(res.data.jobId).metadata?.sandboxId).toBe(res.data.id);
    expect(res.raw).not.toContain(SECRET);
    expect(res.raw).not.toContain("generated");
    release();
    await settle(jobs);
  });

  test("a retry with the same name returns the sandbox being created", async () => {
    const { call, fake, jobs } = await setup();
    const release = fake.holdCreate();
    const args = { spec: { source: { image: "dev-base" } }, name: "agent-box" };
    const first = await call("create_sandbox", args);
    const retry = await call("create_sandbox", args);
    expect(retry.data).toEqual({
      id: first.data.id,
      status: "creating",
      jobId: first.data.jobId,
      existing: true,
    });
    release();
    await settle(jobs);
    expect(fake.calls.created).toHaveLength(1);
    expect(fake.calls.created[0]?.annotations?.["atelier.dev/name"]).toBe(
      "agent-box",
    );
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
    expect(res.data.sandboxes).toEqual([
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
    expect(paused.data.sandboxes.map((s: { id: string }) => s.id)).toEqual([
      "old",
    ]);
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

  test("get_sandbox answers `creating` for a create job that has not landed", async () => {
    const { call, fake, jobs } = await setup();
    const getLabels = fake.runtime.getLabels;
    fake.runtime.getLabels = () => undefined as never;
    fake.runtime.getStatus = () => undefined as never;
    const release = fake.holdCreate();
    const created = await call("create_sandbox", {
      spec: { source: { image: "dev-base" } },
    });
    const res = await call("get_sandbox", { id: created.data.id });
    expect(res.data).toEqual({ id: created.data.id, status: "creating" });
    fake.runtime.getLabels = getLabels;
    release();
    await settle(jobs);
  });

  test("get_sandbox waitSeconds + until long-polls the status", async () => {
    const { call, fake } = await setup();
    fake.setStatus("creating");
    setTimeout(() => fake.setStatus("running"), 100);
    const started = Date.now();
    const res = await call("get_sandbox", {
      id: "sbx-1",
      waitSeconds: 5,
      until: "running",
    });
    expect(res.data.status).toBe("running");
    expect(Date.now() - started).toBeLessThan(4_000);

    // Settled somewhere else (error): returned at once, not after 5 s.
    fake.setStatus("error");
    const failed = Date.now();
    await call("get_sandbox", { id: "sbx-1", waitSeconds: 5 });
    expect(Date.now() - failed).toBeLessThan(2_000);
  });

  test("get_sandbox takes `stopped` as a status filter; wait params are for one sandbox", async () => {
    const { call } = await setup();
    expect((await call("get_sandbox", { status: "stopped" })).isError).toBe(
      false,
    );
    const res = await call("get_sandbox", { waitSeconds: 1 });
    expect(res.data.error).toBe("VALIDATION_ERROR");
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
      orgs: [
        { orgId: org.id, name: `Org ${user.id}`, role: "owner", default: true },
      ],
      personalOrgId: org.id,
      defaultOrgId: org.id,
      defaultImage: "dev-base",
      toolboxes: [],
      prebuilds: [],
    });
    expect(res.raw).not.toContain("@example.test");
  });

  test("whoami summarizes the toolboxes and prebuilds a create can use", async () => {
    const { call, fake, user } = await setup();
    const org = control.organizationService.create(
      `Org2 ${user.id}`,
      `org2-${user.id}`,
      true,
    );
    control.orgMemberService.addMember(org.id, user.id, "owner");
    const tb = control.toolboxService.create(org.id, {
      slug: "pi-tools",
      description: "pi and friends",
      build: [],
      paths: [],
      autoInject: false,
    });
    fake.setBakes([
      {
        ref: "snap-web",
        createdAt: "2026-02-01T00:00:00Z",
        metadata: { name: "web" },
        spec: { repos: [{ url: "https://github.com/acme/web" }] },
      },
    ]);
    const res = await call("whoami");
    expect(res.data.toolboxes).toContainEqual({
      selector: `tb/${tb.id}`,
      description: "pi and friends",
      orgId: org.id,
      autoInclude: false,
    });
    expect(res.data.prebuilds).toEqual([
      {
        ref: "snap-web",
        name: "web",
        repos: ["https://github.com/acme/web"],
        createdAt: "2026-02-01T00:00:00Z",
      },
    ]);
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

  test("fork returns the copy's id at once and re-attributes it to the caller", async () => {
    const { call, fake, user, jobs } = await setup();
    const res = await call("sandbox_lifecycle", {
      id: "src",
      action: "fork",
      name: "copy",
    });
    expect(res.isError).toBe(false);
    expect(res.data).toEqual({
      id: expect.any(String),
      status: "creating",
      jobId: expect.any(String),
      forkOf: "src",
    });
    expect(res.raw).not.toContain(SECRET);
    await settle(jobs);

    const [forked] = fake.calls.forked;
    expect(forked?.sourceId).toBe("src");
    expect(forked?.name).toBe("copy");
    const dump = JSON.stringify(forked?.spec);
    expect(dump).not.toContain("alice@alice.test");
    expect(dump).not.toContain("u-alice");
    expect(dump).not.toContain("ghp_alice");
    expect(forked?.spec.metadata).toEqual({ "atelier.dev/owner-id": user.id });
    expect(forked?.spec.annotations).toEqual({
      "atelier.dev/owner": user.username,
      "atelier.dev/owner-email": user.email,
      "atelier.dev/org-id": "org-1",
    });
  });

  test("every lifecycle action shows in the jobs feed", async () => {
    const { call, jobs } = await setup();
    await call("sandbox_lifecycle", { id: "s", action: "pause" });
    await call("sandbox_lifecycle", { id: "s", action: "resume" });
    await call("sandbox_lifecycle", { id: "s", action: "snapshot" });
    await call("sandbox_lifecycle", { id: "src", action: "fork" });
    await call("destroy_sandbox", { id: "s" });
    await call("create_sandbox", { spec: { source: { image: "dev-base" } } });
    await settle(jobs);
    const kinds = jobs
      .list()
      .map((j) => j.kind)
      .sort();
    expect(kinds).toEqual([
      "sandbox-create",
      "sandbox-create",
      "sandbox-destroy",
      "sandbox-pause",
      "sandbox-resume",
      "sandbox-snapshot",
    ]);
    expect(jobs.list().every((j) => j.status === "succeeded")).toBe(true);
  });

  test("name only applies to fork", async () => {
    const { call } = await setup();
    const res = await call("sandbox_lifecycle", {
      id: "s",
      action: "pause",
      name: "x",
    });
    expect(res.isError).toBe(true);
    expect(res.data.error).toBe("VALIDATION_ERROR");
  });

  test("destroy_sandbox says so", async () => {
    const { call } = await setup();
    expect((await call("destroy_sandbox", { id: "s" })).data).toEqual({
      id: "s",
      status: "destroyed",
    });
  });

  test("destroy is no longer a lifecycle action", async () => {
    const { call } = await setup();
    const res = await call("sandbox_lifecycle", { id: "s", action: "destroy" });
    expect(res.isError).toBe(true);
  });

  test("waitSeconds only applies to pause/resume/snapshot", async () => {
    const { call } = await setup();
    const res = await call("sandbox_lifecycle", {
      id: "s",
      action: "fork",
      waitSeconds: 5,
    });
    expect(res.data.error).toBe("VALIDATION_ERROR");
  });

  test("keep_awake sets hours ahead, or clears with 0", async () => {
    const { call, fake } = await setup();
    const before = Date.now();
    const res = await call("sandbox_lifecycle", {
      id: "s",
      action: "keep_awake",
      hours: 8,
    });
    expect(res.isError).toBe(false);
    const until = Date.parse(String(fake.calls.keepAwake[0]));
    expect(until - before).toBeGreaterThanOrEqual(8 * 3_600_000);
    expect(until - before).toBeLessThan(8 * 3_600_000 + 60_000);
    expect(res.data.keepAwakeUntil).toBe(fake.calls.keepAwake[0]);

    await call("sandbox_lifecycle", {
      id: "s",
      action: "keep_awake",
      hours: 0,
    });
    expect(fake.calls.keepAwake.slice(1)).toEqual([null]);
  });

  test("keep_awake needs hours, and only it takes them", async () => {
    const { call, fake } = await setup();
    for (const args of [
      { action: "keep_awake" },
      { action: "pause", hours: 2 },
    ]) {
      const res = await call("sandbox_lifecycle", { id: "s", ...args });
      expect(res.isError).toBe(true);
      expect(res.data.error).toBe("VALIDATION_ERROR");
    }
    expect(fake.calls.keepAwake).toEqual([]);
  });
});

describe("exec", () => {
  test("a non-zero exit is a result; the default timeout is explicit", async () => {
    const { call, fake } = await setup();
    fake.setExec({ exitCode: 2, stdout: "", stderr: "boom" });
    const res = await call("exec", { id: "s", command: "false" });
    expect(res.isError).toBe(false);
    expect(res.data).toEqual({
      exitCode: 2,
      stdout: "",
      stderr: "boom",
      truncated: false,
      durationMs: expect.any(Number),
    });
    expect(fake.calls.exec[0]?.req.timeoutMs).toBe(30_000);

    await call("exec", { id: "s", command: "x", timeoutMs: 5_000 });
    expect(fake.calls.exec[1]?.req.timeoutMs).toBe(5_000);
  });

  test("output keeps its head and tail, flagged, with a hint", async () => {
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
    expect(res.data.stdout.startsWith("aaaa")).toBe(true);
    expect(res.data.stdout).toContain("chars omitted");
    expect(res.data.stdout.endsWith("THE-END")).toBe(true);
    expect(res.data.stdout.length).toBeLessThan(200);
    expect(res.data.hint).toContain("read_files");
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

describe("read_files", () => {
  test("reads a file through exec, with its total size", async () => {
    const { call, fake } = await setup();
    fake.setExec({ exitCode: 0, stdout: "11\nhello world", stderr: "" });
    const res = await call("read_files", { id: "s", paths: ["/tmp/a.txt"] });
    expect(res.data).toEqual({
      files: [{ path: "/tmp/a.txt", content: "hello world", bytes: 11 }],
    });
  });

  test("a path is one quoted shell word, whatever it contains", async () => {
    const { call, fake } = await setup();
    fake.setExec({ exitCode: 0, stdout: "0\n", stderr: "" });
    await call("read_files", {
      id: "s",
      paths: ["/tmp/it's $(id) here; rm -rf /"],
    });
    const command = String(fake.calls.exec[0]?.req.command);
    expect(command).toContain(`'/tmp/it'\\''s $(id) here; rm -rf /'`);
    expect(command).not.toMatch(/ \/tmp\/it's/);
  });

  test("a line range becomes a sed slice; maxBytes cuts and flags", async () => {
    const { call, fake } = await setup();
    fake.setExec({ exitCode: 0, stdout: "11\nhello world", stderr: "" });
    const res = await call("read_files", {
      id: "s",
      paths: ["/tmp/a.txt"],
      fromLine: 5,
      toLine: 9,
      maxBytes: 5,
    });
    expect(String(fake.calls.exec[0]?.req.command)).toContain("sed -n '5,9p'");
    expect(res.data.files[0]).toMatchObject({
      content: "hello",
      truncated: true,
    });
  });

  test("a missing file is that file's error, not a failed call", async () => {
    const { call, fake } = await setup();
    fake.setExec({ exitCode: 2, stdout: "", stderr: "not a readable file\n" });
    const res = await call("read_files", { id: "s", paths: ["/nope"] });
    expect(res.isError).toBe(false);
    expect(res.data.files).toEqual([
      { path: "/nope", error: "not a readable file" },
    ]);
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

describe("write_files", () => {
  const files = [{ path: "/home/dev/a.txt", content: "a" }];

  test("reports success with a count", async () => {
    const { call, fake } = await setup();
    fake.setPatch([{ path: "/home/dev/a.txt", success: true }]);
    const res = await call("write_files", { id: "s", files });
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
    const res = await call("write_files", { id: "s", files });
    expect(res.isError).toBe(true);
    expect(res.data).toEqual({
      written: 1,
      failed: [{ path: "/root/x", error: "permission denied" }],
    });
  });
});

describe("expose_port", () => {
  test("requires a login by default (forward auth)", async () => {
    const { call, fake } = await setup();
    const res = await call("expose_port", { id: "s", name: "api", port: 8080 });
    expect(res.data).toEqual({
      name: "api",
      port: 8080,
      auth: "forward",
      url: "https://api.example.test",
    });
    expect(fake.calls.ports[0]).toMatchObject({
      name: "api",
      port: 8080,
      public: true,
      auth: "forward",
    });
  });

  test("auth none is only used when asked for", async () => {
    const { call, fake } = await setup();
    const res = await call("expose_port", {
      id: "s",
      name: "api",
      port: 8080,
      auth: "none",
    });
    expect(res.data.auth).toBe("none");
    expect(fake.calls.ports[0]).toMatchObject({ auth: "none" });
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
