/**
 * The sandbox access rule through the MCP tools: every tool taking a
 * sandbox id answers NOT_FOUND to a non-member (and never reaches the
 * runtime), `get_sandbox` lists only what the caller may reach, and
 * `create_sandbox` drops the server-owned owner/org keys.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxSpec } from "@atelier/spec";
import type { AuthUser, ControlContainer } from "../../../control/index.ts";
import { config } from "../../../shared/lib/config.ts";
import type { ServerContainer } from "../../container.ts";
import { connectMcp } from "./mcp.test-support.ts";

// Auth bypass (mock/local) allows everything; the rule only bites here.
process.env.ATELIER_SERVER_MODE = "production";

const OWNER = "atelier.dev/owner-id";
const ORG = "atelier.dev/org-id";

let dataDir: string;
let control: ControlContainer;
let registerSandboxTools: typeof import("./sandbox.ts").registerSandboxTools;
let registerTaskTools: typeof import("./tasks.ts").registerTaskTools;
let registerAdminTools: typeof import("./admin.ts").registerAdminTools;
let JobService: typeof import("../../../runtime/jobs.service.ts").JobService;
let SandboxOps: typeof import("../../app/sandbox-ops.ts").SandboxOps;
let ToolboxOps: typeof import("../../app/toolbox-ops.ts").ToolboxOps;
let owner: AuthUser;
let member: AuthUser;
let stranger: AuthUser;
let orgId: string;

const reached: string[] = [];
const created: SandboxSpec[] = [];

function mkUser(name: string): AuthUser {
  // Unique across test files: `bun test` shares one database per process.
  const u = control.userService.upsertFromLogin(
    `mcp-acc-${name}`,
    `mcp-acc-${name}`,
    `${name}@x.test`,
    "",
  );
  // Toolboxes created without an explicit org land in the personal org.
  const personal = control.organizationService.create(
    u.username,
    `mcp-acc-personal-${name}`,
    true,
  );
  control.orgMemberService.addMember(personal.id, u.id, "owner");
  control.userService.setPersonalOrg(u.id, personal.id);
  return { id: u.id, username: u.username, email: u.email, avatarUrl: "" };
}

let previousMode: typeof config.server.mode;

beforeAll(async () => {
  // The env line above only counts if this file loads the config first.
  previousMode = config.server.mode;
  config.server.mode = "production";
  dataDir = await mkdtemp(join(tmpdir(), "atelier-mcp-access-"));
  process.env.DATA_DIR = dataDir;
  process.env.MIGRATIONS_DIR ??= join(import.meta.dir, "../../../../drizzle");
  const { initDatabase } = await import("../../../control/db/client.ts");
  await initDatabase();
  const { createControlContainer } = await import("../../../control/index.ts");
  control = createControlContainer();
  ({ registerSandboxTools } = await import("./sandbox.ts"));
  ({ registerTaskTools } = await import("./tasks.ts"));
  ({ registerAdminTools } = await import("./admin.ts"));
  ({ JobService } = await import("../../../runtime/jobs.service.ts"));
  ({ SandboxOps } = await import("../../app/sandbox-ops.ts"));
  ({ ToolboxOps } = await import("../../app/toolbox-ops.ts"));
  owner = mkUser("owner");
  member = mkUser("member");
  stranger = mkUser("stranger");
  orgId = control.organizationService.create("Acme", "mcp-acc-org").id;
  control.orgMemberService.addMember(orgId, member.id, "member");
  control.orgMemberService.addMember(orgId, owner.id, "owner");
});

afterAll(async () => {
  config.server.mode = previousMode;
  await rm(dataDir, { recursive: true, force: true });
});

const LABELS: Record<
  string,
  { metadata: Record<string, string>; annotations: Record<string, string> }
> = {
  shared: { metadata: { [OWNER]: "mcp-acc-owner" }, annotations: {} },
  unowned: { metadata: {}, annotations: {} },
};

function fakeContainer(): ServerContainer {
  const track = (id: string) => reached.push(id);
  const labels = {
    ...LABELS,
    shared: {
      metadata: { [OWNER]: owner.id },
      annotations: { [ORG]: orgId },
    },
  };
  const runtime = {
    getStatus: () => "running",
    assertSnapshottable: () => undefined,
    getLabels: (id: string) => labels[id as keyof typeof labels],
    snapshotOwner: (ref: string) =>
      ref === "snap-shared" ? "shared" : undefined,
    list: () =>
      Object.entries(labels).map(([id, l]) => ({
        id,
        status: "running",
        createdAt: "2026-01-01T00:00:00Z",
        ...l,
      })),
    get: async (id: string) => {
      track(id);
      return { id, status: "running", urls: [], processes: [] };
    },
    pause: async (id: string) => {
      track(id);
      return { ref: "r" };
    },
    destroy: async (id: string) => {
      track(id);
    },
    exec: async (id: string) => {
      track(id);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    processAction: async (id: string) => {
      track(id);
    },
    processLogs: async (id: string) => {
      track(id);
      return { content: "", nextOffset: 0 };
    },
    patchFiles: async (id: string) => {
      track(id);
      return { results: [] };
    },
    addPort: async (id: string) => {
      track(id);
    },
    captureToolset: async (id: string) => {
      track(id);
      return { ref: "r" };
    },
    create: async (spec: SandboxSpec) => {
      created.push(spec);
      return { id: "new", urls: [] };
    },
    prebuildSurface: () => undefined,
    defaultImage: () => "dev-base",
  };
  const tasks = {
    dispatchTask: async (_u: string, req: { sandboxId: string }) => {
      track(req.sandboxId);
      throw new Error("started");
    },
  };
  const idle = {
    decorate: <T>(rows: T[]) => rows,
    summary: () => undefined,
    setKeepAwake: (id: string) => {
      track(id);
    },
  };
  const jobs = new JobService();
  const toolboxOps = new ToolboxOps({ runtime, control, jobs } as never);
  const sandboxOps = new SandboxOps({
    runtime,
    control,
    jobs,
    toolboxes: toolboxOps,
    idle,
  } as never);
  return {
    runtime,
    control,
    tasks,
    idle,
    jobs,
    sandboxOps,
    toolboxOps,
  } as unknown as ServerContainer;
}

/** The create job boots in the background: wait for its runtime call. */
async function until(done: () => boolean) {
  for (let i = 0; i < 200 && !done(); i++) await Bun.sleep(5);
  expect(done()).toBe(true);
}

async function as(user: AuthUser) {
  const container = fakeContainer();
  const mcp = await connectMcp((server) => {
    registerSandboxTools(server, container, user);
    registerTaskTools(server, container, user);
    registerAdminTools(server, container, user);
  });
  return mcp;
}

const SANDBOX_CALLS: [string, Record<string, unknown>][] = [
  ["get_sandbox", { id: "shared" }],
  ["sandbox_lifecycle", { id: "shared", action: "pause" }],
  ["destroy_sandbox", { id: "shared" }],
  ["exec", { id: "shared", command: "id" }],
  ["manage_process", { id: "shared", name: "web", action: "logs" }],
  ["manage_process", { id: "shared", name: "web", action: "start" }],
  ["write_files", { id: "shared", files: [{ path: "/tmp/a", content: "x" }] }],
  ["read_files", { id: "shared", paths: ["/tmp/a"] }],
  ["expose_port", { id: "shared", name: "web", port: 3000 }],
  ["send_prompt", { sandboxId: "shared", prompt: "hi" }],
];

describe("MCP sandbox access", () => {
  for (const [tool, args] of SANDBOX_CALLS) {
    test(`${tool} ${JSON.stringify(args.action ?? "")}: a non-member gets NOT_FOUND`, async () => {
      reached.length = 0;
      const denied = await as(stranger);
      const res = await denied.call(tool, args);
      await denied.close();
      expect(res.isError).toBe(true);
      expect(res.data.error).toBe("NOT_FOUND");
      expect(reached).toEqual([]);

      // Members and the owner get past the guard (to the runtime).
      for (const user of [owner, member]) {
        reached.length = 0;
        const allowed = await as(user);
        await allowed.call(tool, args);
        await allowed.close();
        expect(reached).toContain("shared");
      }
    });
  }

  test("toolbox capture of someone else's sandbox is NOT_FOUND", async () => {
    const mcp = await as(stranger);
    const strangerOrg = control.organizationService.create(
      "Stranger",
      "mcp-acc-stranger-org",
    );
    control.orgMemberService.addMember(strangerOrg.id, stranger.id, "owner");
    const tb = control.toolboxService.create(strangerOrg.id, {
      slug: "mine",
      description: "d",
      build: ["true"],
      paths: [".local"],
    } as never);
    reached.length = 0;
    const res = await mcp.call("manage_toolbox", {
      action: "capture",
      id: tb.id,
      sandboxId: "shared",
      note: "n",
    });
    await mcp.close();
    expect(res.data.error).toBe("NOT_FOUND");
    expect(reached).toEqual([]);
  });

  test("an unknown sandbox is NOT_FOUND for everyone", async () => {
    const mcp = await as(owner);
    const res = await mcp.call("get_sandbox", { id: "nope" });
    await mcp.close();
    expect(res.data.error).toBe("NOT_FOUND");
  });

  test("get_sandbox lists only the sandboxes the caller may reach", async () => {
    const idsFor = async (user: AuthUser) => {
      const mcp = await as(user);
      const res = await mcp.call("get_sandbox");
      await mcp.close();
      return res.data.sandboxes.map((s: { id: string }) => s.id).sort();
    };
    expect(await idsFor(stranger)).toEqual([]);
    expect(await idsFor(member)).toEqual(["shared"]);
    expect(await idsFor(owner)).toEqual(["shared"]);
  });

  test("create_sandbox from a sandbox's snapshot needs access to that sandbox", async () => {
    const boot = async (user: AuthUser, snapshot: string) => {
      const mcp = await as(user);
      const res = await mcp.call("create_sandbox", {
        spec: { source: { snapshot } },
      });
      await mcp.close();
      return res;
    };
    created.length = 0;
    const denied = await boot(stranger, "snap-shared");
    expect(denied.data.error).toBe("NOT_FOUND");
    expect(created).toEqual([]);
    const ok = await boot(member, "snap-shared");
    expect(ok.isError).toBe(false);
    expect(ok.data.status).toBe("creating");
    expect((await boot(stranger, "prebuild-snap")).isError).toBe(false);
    await until(() => created.length === 2);
  });

  test("manage_prebuilds and manage_toolbox sources are checked too", async () => {
    const mcp = await as(stranger);
    const scoped = { snapshot: "snap-shared" };
    const prebuild = await mcp.call("manage_prebuilds", {
      action: "create",
      spec: { source: scoped },
    });
    expect(prebuild.data.error).toBe("NOT_FOUND");
    const input = (slug: string, source: unknown) => ({
      slug,
      description: "d",
      build: ["true"],
      paths: [".local"],
      source,
    });
    const create = await mcp.call("manage_toolbox", {
      action: "create",
      config: input("mcp-denied", scoped),
    });
    expect(create.data.error).toBe("NOT_FOUND");
    const made = await mcp.call("manage_toolbox", {
      action: "create",
      config: input("mcp-ok", { snapshot: "prebuild-snap" }),
    });
    expect(made.isError).toBe(false);
    const update = await mcp.call("manage_toolbox", {
      action: "update",
      id: made.data.id,
      config: { source: scoped },
    });
    expect(update.data.error).toBe("NOT_FOUND");
    await mcp.close();
  });

  test("create_sandbox drops a caller-supplied owner-id and org-id", async () => {
    created.length = 0;
    const mcp = await as(member);
    const res = await mcp.call("create_sandbox", {
      spec: {
        source: { image: "dev-base" },
        metadata: { [OWNER]: owner.id, keep: "me" },
        annotations: { [ORG]: "someone-elses-org", note: "x" },
      },
    });
    await mcp.close();
    expect(res.isError).toBe(false);
    await until(() => created.length > 0);
    const spec = created[0];
    // The owner is the caller (set by enrichment), never the supplied one.
    expect(spec?.metadata?.[OWNER]).toBe(member.id);
    expect(spec?.metadata?.keep).toBe("me");
    // The org is the one resolved for the caller (their personal org, with
    // no default org configured), never the supplied one.
    expect(spec?.annotations?.[ORG]).toBe(
      control.userService.getById(member.id)?.personalOrgId,
    );
    expect(spec?.annotations?.note).toBe("x");
  });
});
