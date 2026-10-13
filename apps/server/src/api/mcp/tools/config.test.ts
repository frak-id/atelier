/**
 * The config MCP tools (server config, prebuilds, toolboxes) through a real
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
import type { PrebuildRecord, ToolboxOwner } from "@atelier/spec";
import type { AuthUser, ControlContainer } from "../../../control/index.ts";
import { OWNER_ID_METADATA } from "../../../shared/lib/git-attribution.ts";
import type { ServerContainer } from "../../container.ts";
import { connectMcp } from "./mcp.test-support.ts";

let dataDir: string;
let control: ControlContainer;
let registerConfigTools: typeof import("./config.ts").registerConfigTools;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "atelier-mcp-config-"));
  process.env.DATA_DIR = dataDir;
  process.env.MIGRATIONS_DIR ??= join(import.meta.dir, "../../../../drizzle");
  const { initDatabase } = await import("../../../control/db/client.ts");
  await initDatabase();
  const { createControlContainer } = await import("../../../control/index.ts");
  control = createControlContainer();
  ({ registerConfigTools } = await import("./config.ts"));
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
 * rule whatever the server mode (no reliance on the mock-mode bypass). */
function fakeRuntime(ownerId: string) {
  const toolsets = new Map<string, { private: boolean }>();
  const calls = { deleted: [] as string[], published: [] as string[] };
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
    getToolsetEntry: (ref: string) => toolsets.get(ref),
    publishToolset: (ref: string) => {
      calls.published.push(ref);
      const entry = { private: false };
      toolsets.set(ref, entry);
      return entry;
    },
  };
  return { runtime, calls };
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
  return { id: u.id, username: u.username, email: u.email, avatarUrl: "" };
}

function newOrg(name: string) {
  seq++;
  return control.organizationService.create(name, `mcp-cfg-org-${seq}`);
}

async function connectAs(user: AuthUser) {
  const fake = fakeRuntime(user.id);
  const container = {
    runtime: fake.runtime,
    control,
  } as unknown as ServerContainer;
  const mcp = await connectMcp((server) =>
    registerConfigTools(server, container, user),
  );
  cleanups.push(() => mcp.close());
  return { ...mcp, ...fake };
}

function addToolbox(
  owner: ToolboxOwner,
  slug: string,
  autoInject: boolean,
  extra: { build?: string[]; paths?: string[] } = {},
) {
  return control.toolboxService.create(owner, {
    slug,
    description: `${slug} toolbox`,
    build: extra.build ?? [],
    paths: extra.paths ?? [],
    autoInject,
  });
}

// ── manage_prebuilds ────────────────────────────────────────────────────────

describe("manage_prebuilds list", () => {
  test("returns ref, repos and creation date, newest first", async () => {
    const { call } = await connectAs(newUser());
    const res = await call("manage_prebuilds", { action: "list" });
    expect(res.data).toEqual([
      {
        ref: "snap-web",
        createdAt: "2026-02-01T00:00:00Z",
        repos: [{ url: "https://github.com/acme/web", branch: "main" }],
      },
      {
        ref: "snap-api",
        createdAt: "2026-01-01T00:00:00Z",
        repos: [{ url: "https://github.com/acme/api" }],
      },
    ]);
  });

  test("never exposes the base image, hash, metadata or recipe values", async () => {
    const { call } = await connectAs(newUser());
    // `detail` is not an argument any more: asking for it changes nothing.
    const res = await call("manage_prebuilds", {
      action: "list",
      detail: "advanced",
    });
    for (const item of res.data) {
      expect(Object.keys(item).sort()).toEqual(["createdAt", "ref", "repos"]);
    }
    for (const hidden of [
      "sha256", // image digest
      "aaaaaaaa", // content hash
      "workspace", // metadata
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
    expect(res.data.map((p: { ref: string }) => p.ref)).toEqual(["snap-api"]);
  });
});

describe("manage_prebuilds create/delete", () => {
  test("create returns the ref without the content hash", async () => {
    const { call } = await connectAs(newUser());
    const res = await call("manage_prebuilds", {
      action: "create",
      spec: { source: { image: "dev-base" } },
    });
    expect(res.data).toEqual({ ref: "snap-new" });
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

// ── list_toolboxes ──────────────────────────────────────────────────────────

function world() {
  const user = newUser();
  const org = newOrg("Acme");
  const otherOrg = newOrg("Not mine");
  control.orgMemberService.addMember(org.id, user.id, "member");
  const userOwner: ToolboxOwner = { type: "user", id: user.id };
  const orgOwner: ToolboxOwner = { type: "org", id: org.id };
  const mine = addToolbox(userOwner, "mine", true);
  const optional = addToolbox(userOwner, "optional", false);
  const baseline = addToolbox(orgOwner, "baseline", true);
  const extras = addToolbox(orgOwner, "extras", false);
  addToolbox({ type: "org", id: otherOrg.id }, "secret", true);
  return { user, org, otherOrg, mine, optional, baseline, extras };
}

describe("list_toolboxes", () => {
  test("lists your own AND your orgs' toolboxes, auto-included first", async () => {
    const w = world();
    const { call } = await connectAs(w.user);
    const res = await call("list_toolboxes");
    expect(
      res.data.map((t: { slug: string; appliesTo: string }) => [
        t.slug,
        t.appliesTo,
      ]),
    ).toEqual([
      // injection order: org baseline, then your overlay, then the rest
      ["baseline", "sandboxes-in-org"],
      ["mine", "every-sandbox"],
      ["optional", "explicit-only"],
      ["extras", "explicit-only"],
    ]);
    // another org's toolbox is not visible
    expect(res.raw).not.toContain("secret");
  });

  test("each item says what it is, where it applies and how to select it", async () => {
    const w = world();
    const { call } = await connectAs(w.user);
    const items = (await call("list_toolboxes")).data;
    const baseline = items.find((t: { slug: string }) => t.slug === "baseline");
    const mine = items.find((t: { slug: string }) => t.slug === "mine");
    expect(baseline).toEqual({
      selector: `tb/org/${w.org.id}/baseline`,
      id: w.baseline.id,
      slug: "baseline",
      description: "baseline toolbox",
      scope: "org",
      orgId: w.org.id,
      autoInclude: true,
      appliesTo: "sandboxes-in-org",
      activeVersion: null,
      // a plain member sees neither the version history nor can manage
      canManage: false,
    });
    expect(mine).toEqual({
      selector: `tb/user/${w.user.id}/mine`,
      id: w.mine.id,
      slug: "mine",
      description: "mine toolbox",
      scope: "user",
      autoInclude: true,
      appliesTo: "every-sandbox",
      activeVersion: null,
      versionCount: 0,
      canManage: true,
    });
  });

  test("owner narrows the scope", async () => {
    const w = world();
    const { call } = await connectAs(w.user);
    const slugs = (res: { data: { slug: string }[] }) =>
      res.data.map((t) => t.slug).sort();

    expect(slugs(await call("list_toolboxes", { owner: "me" }))).toEqual([
      "mine",
      "optional",
    ]);
    expect(
      slugs(await call("list_toolboxes", { owner: `org:${w.org.id}` })),
    ).toEqual(["baseline", "extras"]);

    const foreign = await call("list_toolboxes", {
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
    const simple = (await call("list_toolboxes", { owner: "me" })).data;
    expect(simple[0]).not.toHaveProperty("build");
    expect(simple[0]).not.toHaveProperty("versions");
    expect(
      simple.find((t: { slug: string }) => t.slug === "mine"),
    ).toMatchObject({
      versionCount: 1,
    });

    const res = await call("list_toolboxes", {
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

  test("an org admin sees and can manage the org's toolboxes", async () => {
    const w = world();
    const admin = newUser();
    control.orgMemberService.addMember(w.org.id, admin.id, "admin");
    const { call } = await connectAs(admin);
    const baseline = (
      await call("list_toolboxes", { owner: `org:${w.org.id}` })
    ).data[0];
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
    expect(res.data).toMatchObject({
      selector: `tb/user/${user.id}/fresh`,
      autoInclude: true,
      appliesTo: "every-sandbox",
      canManage: true,
    });
    expect(res.raw).not.toContain("createdAt");
  });

  test("update and delete return small confirmations", async () => {
    const user = newUser();
    const tb = addToolbox({ type: "user", id: user.id }, "tmp", true);
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

  test("a plain org member cannot manage the org's toolbox", async () => {
    const w = world();
    const { call } = await connectAs(w.user);
    const res = await call("manage_toolbox", {
      action: "update",
      id: w.baseline.id,
      config: { description: "hijack" },
    });
    expect(res.isError).toBe(true);
    expect(res.data.error).toBe("FORBIDDEN");
  });

  test("capture → publish → pin on an org toolbox, then unpin → delete_version", async () => {
    const owner = newUser();
    const org = newOrg("Pinning");
    control.orgMemberService.addMember(org.id, owner.id, "owner");
    const tb = addToolbox({ type: "org", id: org.id }, "stack", true, {
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
    const a = addToolbox({ type: "user", id: user.id }, "a", true, {
      paths: ["a"],
    });
    const b = addToolbox({ type: "user", id: user.id }, "b", true);
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

// ── tool surface ────────────────────────────────────────────────────────────

describe("config tool surface", () => {
  test("server-wide config is not exposed over MCP", async () => {
    const { toolNames } = await connectAs(newUser());
    // Operator business (console / CLI); no agent flow needs it, and it was
    // read-only anyway. Guard against it creeping back in.
    expect(await toolNames()).toEqual([
      "list_toolboxes",
      "manage_prebuilds",
      "manage_toolbox",
    ]);
  });
});
