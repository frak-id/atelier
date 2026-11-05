/**
 * The admin MCP tools (prebuilds, toolboxes, images, server config) through a real
 * MCP client, against a real control DB (so org membership, roles and the
 * toolbox services are the real thing) and a fake runtime.
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
import type { PrebuildRecord } from "@atelier/spec";
import type { AuthUser, ControlContainer } from "../../../control/index.ts";
import { OWNER_ID_METADATA } from "../../../shared/lib/git-attribution.ts";
import type { ServerContainer } from "../../container.ts";
import { connectMcp } from "./mcp.test-support.ts";

let dataDir: string;
let control: ControlContainer;
let registerAdminTools: typeof import("./admin.ts").registerAdminTools;
let SandboxOps: typeof import("../../app/sandbox-ops.ts").SandboxOps;
let JobService: typeof import("../../../runtime/jobs.service.ts").JobService;
let ToolboxOps: typeof import("../../app/toolbox-ops.ts").ToolboxOps;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "atelier-mcp-config-"));
  process.env.DATA_DIR = dataDir;
  process.env.MIGRATIONS_DIR ??= join(import.meta.dir, "../../../../drizzle");
  const { initDatabase } = await import("../../../control/db/client.ts");
  await initDatabase();
  const { createControlContainer } = await import("../../../control/index.ts");
  control = createControlContainer();
  ({ registerAdminTools } = await import("./admin.ts"));
  ({ SandboxOps } = await import("../../app/sandbox-ops.ts"));
  ({ JobService } = await import("../../../runtime/jobs.service.ts"));
  ({ ToolboxOps } = await import("../../app/toolbox-ops.ts"));
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

// ── fakes ───────────────────────────────────────────────────────────────────

const PREBUILDS: PrebuildRecord[] = [
  {
    ref: "snap-web",
    hash: "a".repeat(64),
    image: "registry.test/dev-base@sha256:abc",
    metadata: { workspace: "web" },
    spec: {
      source: { image: "dev-base" },
      repos: [
        {
          url: "https://github.com/acme/web",
          branch: "main",
          clonePath: "web",
        },
      ],
      build: ["bun install"],
      env: { NPM_TOKEN: "literal-npm-token" },
      files: [
        {
          path: "/home/dev/.npmrc",
          content: "literal-file-secret",
          mode: "600",
        },
      ],
      ports: [{ name: "app", port: 3000, public: true }],
      processes: [{ name: "dev", command: "bun dev", lazy: true }],
    },
    inUse: true,
    createdAt: "2026-02-01T00:00:00Z",
  },
  {
    ref: "snap-api",
    hash: "b".repeat(64),
    image: "registry.test/dev-base@sha256:abc",
    parent: "snap-web",
    spec: {
      source: { snapshot: "snap-web" },
      repos: [{ url: "https://github.com/acme/api", clonePath: "api" }],
    },
    inUse: false,
    createdAt: "2026-01-01T00:00:00Z",
  },
];

/** Every sandbox is owned by `ownerId`, so `capture` passes the real access
 * rule whatever the server mode (no reliance on the local-mode auth bypass). */
function fakeRuntime(ownerId: string) {
  const toolsets = new Map<string, { private: boolean }>();
  const calls = {
    deleted: [] as string[],
    published: [] as string[],
    built: [] as string[],
  };
  const runtime = {
    listPrebuilds: () => PREBUILDS,
    prebuild: async () => ({ ref: "snap-new", hash: "c".repeat(64) }),
    deletePrebuild: async (ref: string) => {
      calls.deleted.push(ref);
    },
    getLabels: () => ({
      metadata: { [OWNER_ID_METADATA]: ownerId },
      annotations: {},
    }),
    captureToolset: async () => {
      const ref = `toolsets/cap@sha256:${toolsets.size}`;
      toolsets.set(ref, { private: true });
      return { ref };
    },
    getSandboxImage: async () => "dev-base@sha256:base",
    // Refresh: the update commands always change something here.
    refreshToolset: async (req: { name: string }) => {
      const ref = `toolsets/${req.name}@sha256:${"e".repeat(64)}`;
      toolsets.set(ref, { private: true });
      return { changed: true, ref };
    },
    buildToolset: async (req: { name: string }) => ({
      ref: `toolsets/${req.name}@sha256:${"d".repeat(64)}`,
    }),
    resolveSourceImage: async () => "dev-base@sha256:base",
    defaultImage: () => "dev-base",
    deleteToolset: () => {},
    getToolsetEntry: (ref: string) => toolsets.get(ref),
    publishToolset: (ref: string) => {
      calls.published.push(ref);
      const entry = { private: false };
      toolsets.set(ref, entry);
      return entry;
    },
  };
  const images = {
    listImages: () => [
      {
        name: "dev-base",
        status: "ready",
        provenance: "seed",
        ref: "registry.test/dev-base@sha256:abc",
        buildLog: "secret-looking log noise",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
      },
    ],
    listTemplates: () => [
      { id: "dev-base", dependsOn: [], name: "Base" },
      { id: "dev-rust", dependsOn: ["dev-base"], name: "Rust" },
    ],
    getImage: (name: string) =>
      name === "dev-base" ? { name, status: "ready" } : undefined,
    getBuildLog: () => "step 1\nstep 2",
    buildSeed: async (seed: string) => {
      calls.built.push(seed);
      return { name: seed, status: "building" };
    },
  };
  return { runtime, calls, images };
}

let seq = 0;
function newUser(): AuthUser {
  seq++;
  const u = control.userService.upsertFromLogin(
    `mcp-cfg-${seq}`,
    `cfguser${seq}`,
    `cfguser${seq}@example.test`,
    "",
  );
  // Every user has a personal org (their "personal" toolboxes live there).
  const personal = control.organizationService.create(
    u.username,
    `mcp-cfg-personal-${seq}`,
    true,
  );
  control.orgMemberService.addMember(personal.id, u.id, "owner");
  control.userService.setPersonalOrg(u.id, personal.id);
  return { id: u.id, username: u.username, email: u.email, avatarUrl: "" };
}

function personalOrgOf(user: AuthUser): string {
  return control.userService.getByIdOrThrow(user.id).personalOrgId ?? "";
}

function newOrg(name: string) {
  seq++;
  return control.organizationService.create(name, `mcp-cfg-org-${seq}`);
}

async function connectAs(user: AuthUser) {
  const fake = fakeRuntime(user.id);
  const jobs = new JobService();
  const toolboxOps = new ToolboxOps({
    runtime: fake.runtime,
    control,
    jobs,
  } as never);
  const container = {
    runtime: fake.runtime,
    control,
    jobs,
    toolboxOps,
    sandboxOps: new SandboxOps({
      runtime: fake.runtime,
      control,
      jobs,
      toolboxes: toolboxOps,
      idle: { setKeepAwake: () => undefined },
    } as never),
    images: fake.images,
  } as unknown as ServerContainer;
  const mcp = await connectMcp((server) =>
    registerAdminTools(server, container, user),
  );
  cleanups.push(() => mcp.close());
  return { ...mcp, ...fake, jobs };
}

function addToolbox(
  orgId: string,
  slug: string,
  autoInject: boolean,
  extra: { build?: string[]; paths?: string[] } = {},
) {
  return control.toolboxService.create(orgId, {
    slug,
    description: `${slug} toolbox`,
    build: extra.build ?? [],
    paths: extra.paths ?? [],
    autoInject,
  });
}

type Call = Awaited<ReturnType<typeof connectAs>>["call"];

/** `manage_toolbox` action=list, with the `toolboxes` array as `data`. */
async function listToolboxes(call: Call, args: Record<string, unknown> = {}) {
  const res = await call("manage_toolbox", { action: "list", ...args });
  return { ...res, data: res.data.toolboxes ?? res.data };
}

// ── manage_prebuilds ────────────────────────────────────────────────────────

describe("manage_prebuilds list", () => {
  test("returns ref, repos, metadata, dev servers and creation date, newest first", async () => {
    const { call } = await connectAs(newUser());
    const res = await call("manage_prebuilds", { action: "list" });
    expect(res.data.prebuilds).toEqual([
      {
        ref: "snap-web",
        createdAt: "2026-02-01T00:00:00Z",
        repos: [{ url: "https://github.com/acme/web", branch: "main" }],
        metadata: { workspace: "web" },
        processes: [{ name: "dev", command: "bun dev", lazy: true }],
        ports: [{ name: "app", port: 3000, public: true }],
      },
      {
        ref: "snap-api",
        createdAt: "2026-01-01T00:00:00Z",
        repos: [{ url: "https://github.com/acme/api" }],
      },
    ]);
  });

  test("never exposes the base image, hash or build recipe values", async () => {
    const { call } = await connectAs(newUser());
    // `detail` is not an argument any more: asking for it changes nothing.
    const res = await call("manage_prebuilds", {
      action: "list",
      detail: "advanced",
    });
    const allowed = [
      "createdAt",
      "metadata",
      "ports",
      "processes",
      "ref",
      "repos",
    ];
    for (const item of res.data.prebuilds) {
      for (const key of Object.keys(item)) expect(allowed).toContain(key);
    }
    for (const hidden of [
      "sha256", // image digest
      "aaaaaaaa", // content hash
      "clonePath",
      "bun install", // build step
      "literal-npm-token", // env value
      "literal-file-secret", // file content
      "inUse",
    ]) {
      expect(res.raw).not.toContain(hidden);
    }
  });

  test("repo filters by url", async () => {
    const { call } = await connectAs(newUser());
    const res = await call("manage_prebuilds", {
      action: "list",
      repo: "acme/api",
    });
    expect(res.data.prebuilds.map((p: { ref: string }) => p.ref)).toEqual([
      "snap-api",
    ]);
  });
});

describe("manage_prebuilds create/refresh/delete", () => {
  test("create starts a background job and returns its id", async () => {
    const { call, jobs } = await connectAs(newUser());
    const res = await call("manage_prebuilds", {
      action: "create",
      spec: { source: { image: "dev-base" } },
    });
    expect(res.data).toMatchObject({ status: "started" });
    expect(jobs.get(res.data.jobId).kind).toBe("prebuild");
  });

  test("refresh rebuilds a listed prebuild's recipe, ignoring the cache", async () => {
    const { call, jobs } = await connectAs(newUser());
    const res = await call("manage_prebuilds", {
      action: "refresh",
      ref: "snap-web",
    });
    expect(res.data).toMatchObject({ ref: "snap-web", status: "started" });
    expect(jobs.get(res.data.jobId).kind).toBe("prebuild");
    const missing = await call("manage_prebuilds", {
      action: "refresh",
      ref: "nope",
    });
    expect(missing.data.error).toBe("NOT_FOUND");
  });

  test("delete confirms the ref", async () => {
    const { call, calls } = await connectAs(newUser());
    const res = await call("manage_prebuilds", {
      action: "delete",
      ref: "snap-api",
    });
    expect(res.data).toEqual({ ref: "snap-api", status: "deleted" });
    expect(calls.deleted).toEqual(["snap-api"]);
  });
});

describe("manage_images", () => {
  test("list shows images and the seeds a rebuild takes, without logs", async () => {
    const { call } = await connectAs(newUser());
    const res = await call("manage_images", { action: "list" });
    expect(res.data.seeds.map((s: { id: string }) => s.id)).toEqual([
      "dev-base",
      "dev-rust",
    ]);
    expect(res.data.images[0].name).toBe("dev-base");
    expect(res.raw).not.toContain("log noise");
  });

  test("rebuild starts a seed build; logs reads the tail", async () => {
    const { call, calls } = await connectAs(newUser());
    const built = await call("manage_images", {
      action: "rebuild",
      name: "dev-rust",
    });
    expect(built.data).toEqual({ name: "dev-rust", status: "building" });
    expect(calls.built).toEqual(["dev-rust"]);
    const logs = await call("manage_images", {
      action: "logs",
      name: "dev-base",
    });
    expect(logs.data.log).toBe("step 1\nstep 2");
    const missing = await call("manage_images", {
      action: "logs",
      name: "nope",
    });
    expect(missing.data.error).toBe("NOT_FOUND");
  });
});

// ── list_toolboxes ──────────────────────────────────────────────────────────

function world() {
  const user = newUser();
  const org = newOrg("Acme");
  const otherOrg = newOrg("Not mine");
  control.orgMemberService.addMember(org.id, user.id, "member");
  const personal = personalOrgOf(user);
  const mine = addToolbox(personal, "mine", true);
  const optional = addToolbox(personal, "optional", false);
  const baseline = addToolbox(org.id, "baseline", true);
  const extras = addToolbox(org.id, "extras", false);
  const secret = addToolbox(otherOrg.id, "secret", true);
  return { user, org, otherOrg, mine, optional, baseline, extras, secret };
}

describe("manage_toolbox list", () => {
  test("lists every member org's toolboxes (personal included), auto-included first", async () => {
    const w = world();
    const { call } = await connectAs(w.user);
    const res = await listToolboxes(call);
    const rows = res.data.map((t: { slug: string; appliesTo: string }) => [
      t.slug,
      t.appliesTo,
    ]);
    // auto-included ones first, then the explicit-only ones
    expect(rows.slice(0, 2)).toEqual(
      expect.arrayContaining([
        ["baseline", "sandboxes-in-org"],
        ["mine", "sandboxes-in-org"],
      ]),
    );
    expect(rows.slice(2)).toEqual(
      expect.arrayContaining([
        ["optional", "explicit-only"],
        ["extras", "explicit-only"],
      ]),
    );
    expect(rows).toHaveLength(4);
    // another org's toolbox is not visible
    expect(res.raw).not.toContain("secret");
  });

  test("each item says what it is, where it applies and how to select it", async () => {
    const w = world();
    const { call } = await connectAs(w.user);
    const items = (await listToolboxes(call)).data;
    const baseline = items.find((t: { slug: string }) => t.slug === "baseline");
    const mine = items.find((t: { slug: string }) => t.slug === "mine");
    expect(baseline).toEqual({
      selector: `tb/${w.baseline.id}`,
      id: w.baseline.id,
      slug: "baseline",
      description: "baseline toolbox",
      orgId: w.org.id,
      autoInclude: true,
      appliesTo: "sandboxes-in-org",
      activeVersion: null,
      versionCount: 0,
      // any member of the org manages its toolboxes
      canManage: true,
    });
    expect(mine).toMatchObject({
      selector: `tb/${w.mine.id}`,
      orgId: personalOrgOf(w.user),
      appliesTo: "sandboxes-in-org",
      canManage: true,
    });
  });

  test("owner narrows the scope", async () => {
    const w = world();
    const { call } = await connectAs(w.user);
    const slugs = (res: { data: { slug: string }[] }) =>
      res.data.map((t) => t.slug).sort();

    expect(slugs(await listToolboxes(call, { owner: "me" }))).toEqual([
      "mine",
      "optional",
    ]);
    expect(
      slugs(await listToolboxes(call, { owner: `org:${w.org.id}` })),
    ).toEqual(["baseline", "extras"]);

    const foreign = await listToolboxes(call, {
      owner: `org:${w.otherOrg.id}`,
    });
    expect(foreign.isError).toBe(true);
    expect(foreign.data.error).toBe("FORBIDDEN");
  });

  test("advanced adds the recipe and versions, minus internal hashes", async () => {
    const w = world();
    control.toolboxVersionService.create(w.mine.id, {
      ref: "toolsets/mine@sha256:1",
      description: "first capture",
      provenance: {
        kind: "captured",
        capturedFrom: "sbx-1",
        capturedBy: w.user.id,
        sourceImage: "dev-base@sha256:base",
      },
      recipeFingerprint: "f".repeat(64),
    });
    const { call } = await connectAs(w.user);
    const simple = (await listToolboxes(call, { owner: "me" })).data;
    expect(simple[0]).not.toHaveProperty("build");
    expect(simple[0]).not.toHaveProperty("versions");
    expect(
      simple.find((t: { slug: string }) => t.slug === "mine"),
    ).toMatchObject({
      versionCount: 1,
    });

    const res = await listToolboxes(call, {
      owner: "me",
      detail: "advanced",
    });
    const mine = res.data.find((t: { slug: string }) => t.slug === "mine");
    expect(mine.build).toEqual([]);
    expect(mine.versions).toEqual([
      {
        id: expect.any(String),
        label: 1,
        ref: "toolsets/mine@sha256:1",
        kind: "captured",
        description: "first capture",
        createdAt: expect.any(String),
        capturedFrom: "sbx-1",
        sourceImage: "dev-base@sha256:base",
      },
    ]);
    expect(res.raw).not.toContain("ffffffff"); // recipeFingerprint
    expect(res.raw).not.toContain("capturedBy");
  });

  test("an org owner sees and can manage the org's toolboxes", async () => {
    const w = world();
    const admin = newUser();
    control.orgMemberService.addMember(w.org.id, admin.id, "owner");
    const { call } = await connectAs(admin);
    const baseline = (await listToolboxes(call, { owner: `org:${w.org.id}` }))
      .data[0];
    expect(baseline).toMatchObject({
      slug: "baseline",
      canManage: true,
      versionCount: 0,
    });
  });
});

// ── manage_toolbox ──────────────────────────────────────────────────────────

describe("manage_toolbox", () => {
  test("create returns the toolbox like the listing; new ones auto-include", async () => {
    const user = newUser();
    const { call } = await connectAs(user);
    const res = await call("manage_toolbox", {
      action: "create",
      config: { slug: "fresh", description: "d", build: [], paths: [] },
    });
    // No `owner`: it lands in the caller's personal org.
    expect(res.data).toMatchObject({
      selector: expect.stringMatching(/^tb\//),
      orgId: personalOrgOf(user),
      autoInclude: true,
      appliesTo: "sandboxes-in-org",
      canManage: true,
    });
    expect(res.raw).not.toContain("createdAt");
  });

  test("update and delete return small confirmations", async () => {
    const user = newUser();
    const tb = addToolbox(personalOrgOf(user), "tmp", true);
    const { call } = await connectAs(user);
    const updated = await call("manage_toolbox", {
      action: "update",
      id: tb.id,
      config: { autoInject: false },
    });
    expect(updated.data).toMatchObject({
      slug: "tmp",
      autoInclude: false,
      appliesTo: "explicit-only",
    });
    expect(
      (await call("manage_toolbox", { action: "delete", id: tb.id })).data,
    ).toEqual({ id: tb.id, status: "deleted" });
  });

  test("a member manages the org's toolbox; a non-member is refused", async () => {
    const w = world();
    const { call } = await connectAs(w.user);
    const ok = await call("manage_toolbox", {
      action: "update",
      id: w.baseline.id,
      config: { description: "shared edit" },
    });
    expect(ok.isError).toBeFalsy();
    expect(ok.data).toMatchObject({ description: "shared edit" });

    const res = await call("manage_toolbox", {
      action: "update",
      id: w.secret.id,
      config: { description: "hijack" },
    });
    expect(res.isError).toBe(true);
    expect(res.data.error).toBe("FORBIDDEN");
  });

  test("create accepts files, secret refs included", async () => {
    const user = newUser();
    const { call } = await connectAs(user);
    const files = [
      {
        path: "/home/dev/.config/x/key",
        content: { $secret: "X_KEY" },
        mode: "600",
        owner: "dev",
      },
    ];
    const res = await call("manage_toolbox", {
      action: "create",
      config: {
        slug: "files-only",
        description: "d",
        build: [],
        paths: [],
        files,
      },
    });
    expect(res.isError).toBeFalsy();
    const stored = control.toolboxService.get((res.data as { id: string }).id);
    expect(stored.files).toEqual(files);
  });

  test("capture → publish → pin on an org toolbox, then unpin → delete_version", async () => {
    const owner = newUser();
    const org = newOrg("Pinning");
    control.orgMemberService.addMember(org.id, owner.id, "owner");
    const tb = addToolbox(org.id, "stack", true, {
      paths: [".config/tool"],
    });
    const { call, calls } = await connectAs(owner);

    const captured = await call("manage_toolbox", {
      action: "capture",
      id: tb.id,
      sandboxId: "sbx-1",
      note: "baseline setup",
    });
    expect(captured.data).toMatchObject({ id: tb.id, label: 1, private: true });
    expect(captured.raw).not.toContain("recipeFingerprint");
    const versionId = captured.data.versionId as string;

    // A private capture must not be pinned org-wide.
    const early = await call("manage_toolbox", {
      action: "pin_version",
      id: tb.id,
      versionId,
    });
    expect(early.isError).toBe(true);
    expect(early.data.message).toContain("publish");

    expect(
      (
        await call("manage_toolbox", {
          action: "publish",
          id: tb.id,
          versionId,
        })
      ).data,
    ).toEqual({ id: tb.id, versionId, private: false });
    expect(calls.published).toHaveLength(1);

    expect(
      (
        await call("manage_toolbox", {
          action: "pin_version",
          id: tb.id,
          versionId,
        })
      ).data,
    ).toEqual({ id: tb.id, activeVersionId: versionId });

    // The active version cannot be deleted until it is unpinned.
    const refused = await call("manage_toolbox", {
      action: "delete_version",
      id: tb.id,
      versionId,
    });
    expect(refused.isError).toBe(true);
    expect(refused.data.message).toContain("unpin");

    await call("manage_toolbox", {
      action: "pin_version",
      id: tb.id,
      versionId: null,
    });
    expect(
      (
        await call("manage_toolbox", {
          action: "delete_version",
          id: tb.id,
          versionId,
        })
      ).data,
    ).toEqual({ id: tb.id, versionId, status: "deleted" });
  });

  test("a version of another toolbox is refused", async () => {
    const user = newUser();
    const a = addToolbox(personalOrgOf(user), "a", true, {
      paths: ["a"],
    });
    const b = addToolbox(personalOrgOf(user), "b", true);
    const { call } = await connectAs(user);
    const cap = await call("manage_toolbox", {
      action: "capture",
      id: a.id,
      sandboxId: "sbx-1",
      note: "n",
    });
    const res = await call("manage_toolbox", {
      action: "pin_version",
      id: b.id,
      versionId: cap.data.versionId,
    });
    expect(res.isError).toBe(true);
    expect(res.data.message).toContain("does not belong");
  });
});

describe("manage_toolbox refresh", () => {
  test("set up through update, run, then read back in the toolbox list", async () => {
    const owner = newUser();
    const org = newOrg("Refreshing");
    control.orgMemberService.addMember(org.id, owner.id, "owner");
    const tb = addToolbox(org.id, "pi-web", true, {
      paths: ["~/.pi/agent"],
    });
    const { call, calls, jobs } = await connectAs(owner);

    const updated = await call("manage_toolbox", {
      action: "update",
      id: tb.id,
      config: { refresh: ["pi update --all"], refreshSchedule: "@daily" },
    });
    expect(updated.data.refresh).toMatchObject({
      commands: ["pi update --all"],
      schedule: "@daily",
      nextRunAt: expect.any(String),
      running: false,
    });

    const started = await call("manage_toolbox", {
      action: "refresh",
      id: tb.id,
    });
    expect(started.data).toEqual({
      id: tb.id,
      jobId: expect.any(String),
      status: "started",
    });
    for (let i = 0; i < 50; i++) {
      if (jobs.get(started.data.jobId).status === "succeeded") break;
      await Bun.sleep(5);
    }

    const listed = (
      await listToolboxes(call, { owner: `org:${org.id}` })
    ).data.find((t: { slug: string }) => t.slug === "pi-web");
    expect(listed.refresh).toMatchObject({
      running: false,
      last: { trigger: "manual", outcome: "updated", pinned: true },
    });
    // Nothing was pinned: the recipe build became v1, the refresh v2.
    expect(listed.activeVersion).toMatchObject({
      id: listed.refresh.last.versionId,
      label: 2,
    });
    // An org toolbox's refreshed version is published so it can be pinned.
    expect(calls.published).toHaveLength(1);
  });

  test("refused without update commands; bad schedules are refused", async () => {
    const user = newUser();
    const tb = addToolbox(personalOrgOf(user), "plain", true, {
      paths: ["~/.x"],
    });
    const { call } = await connectAs(user);

    const res = await call("manage_toolbox", { action: "refresh", id: tb.id });
    expect(res.isError).toBe(true);
    expect(res.data.message).toContain("update commands");

    const bad = await call("manage_toolbox", {
      action: "update",
      id: tb.id,
      config: { refresh: ["x"], refreshSchedule: "* * * * *" },
    });
    expect(bad.isError).toBe(true);
    expect(bad.data.message).toContain("once an hour");
  });

  test("a non-member cannot refresh another org's toolbox", async () => {
    const w = world();
    const { call } = await connectAs(w.user);
    const res = await call("manage_toolbox", {
      action: "refresh",
      id: w.secret.id,
    });
    expect(res.isError).toBe(true);
    expect(res.data.error).toBe("FORBIDDEN");
  });
});

// ── tool surface ────────────────────────────────────────────────────────────

describe("server_config", () => {
  test("list, get and set a known key; an unknown key is refused", async () => {
    const { call } = await connectAs(newUser());
    const list = await call("server_config", { action: "list" });
    expect(
      list.data.entries.some(
        (e: { key: string }) => e.key === "jobs.concurrency",
      ),
    ).toBe(true);
    const set = await call("server_config", {
      action: "set",
      key: "jobs.concurrency",
      value: 3,
    });
    expect(set.data).toEqual({ key: "jobs.concurrency", value: 3 });
    const got = await call("server_config", {
      action: "get",
      key: "jobs.concurrency",
    });
    expect(got.data.value).toBe(3);
    const bad = await call("server_config", {
      action: "set",
      key: "no.such.key",
      value: 1,
    });
    expect(bad.data.error).toBe("VALIDATION_ERROR");
  });
});

describe("manage_toolbox transfer", () => {
  test("dryRun previews; moving needs ownership of the source org", async () => {
    const user = newUser();
    const other = newUser();
    const personal = personalOrgOf(user);
    const org = newOrg("Team");
    control.orgMemberService.addMember(org.id, user.id, "member");
    const tb = addToolbox(personal, "movable", false);
    const { call } = await connectAs(user);

    const preview = await call("manage_toolbox", {
      action: "transfer",
      from: personal,
      to: org.id,
      dryRun: true,
    });
    expect(preview.isError).toBe(false);

    const moved = await call("manage_toolbox", {
      action: "transfer",
      from: personal,
      to: org.id,
      toolboxIds: [tb.id],
    });
    expect(moved.isError).toBe(false);
    expect(control.toolboxService.get(tb.id).orgId).toBe(org.id);

    const foreign = await call("manage_toolbox", {
      action: "transfer",
      from: personalOrgOf(other),
      to: org.id,
      dryRun: true,
    });
    expect(foreign.data.error).toBe("FORBIDDEN");
  });
});

describe("admin tool surface", () => {
  test("is exactly these 4 tools, in this order", async () => {
    const { toolNames } = await connectAs(newUser());
    expect(await toolNames()).toEqual([
      "manage_prebuilds",
      "manage_toolbox",
      "manage_images",
      "server_config",
    ]);
  });
});
