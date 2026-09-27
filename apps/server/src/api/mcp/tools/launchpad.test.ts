/**
 * The Launchpad MCP tools against a real control DB + job queue and a fake
 * runtime (mirrors `launchpad.lifecycle.test.ts`'s setup) — each tool's
 * happy path, plus the authorization/not-found case for another user's
 * workspace, driven through `registerLaunchpadTools` exactly as `/mcp`
 * calls it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxStatus, SandboxUrl, StarterInput } from "@atelier/spec";
import type { AuthUser, ControlContainer } from "../../../control/index.ts";
import { InMemoryJobStore, JobService } from "../../../runtime/index.ts";
import { NotFoundError } from "../../../shared/errors.ts";
import type { ServerContainer } from "../../container.ts";
import type { registerLaunchpadTools as RegisterLaunchpadTools } from "./launchpad.ts";

let dataDir: string;
let control: ControlContainer;
let registerLaunchpadTools: typeof RegisterLaunchpadTools;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "atelier-mcp-launchpad-"));
  process.env.DATA_DIR = dataDir;
  process.env.MIGRATIONS_DIR ??= join(import.meta.dir, "../../../../drizzle");
  const { initDatabase } = await import("../../../control/db/client.ts");
  await initDatabase();
  const { createControlContainer } = await import("../../../control/index.ts");
  control = createControlContainer();
  ({ registerLaunchpadTools } = await import("./launchpad.ts"));
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

// ── fakes ───────────────────────────────────────────────────────────────────

interface FakeSandbox {
  status: SandboxStatus;
  urls: SandboxUrl[];
}

const PI_URL: SandboxUrl = {
  name: "pi",
  url: "https://pi.example.test",
  processes: ["pi-web"],
  ready: true,
};

/** Just enough runtime for the lifecycle behind the tools: an in-memory
 * record map, plus `create` (`createSandboxForUser`'s terminal call) so
 * `launchpad_launch` can run for real, unmocked. */
function fakeRuntime() {
  const sandboxes = new Map<string, FakeSandbox>();
  const requireSandbox = (id: string) => {
    const sandbox = sandboxes.get(id);
    if (!sandbox) throw new NotFoundError("Sandbox", id);
    return sandbox;
  };
  const runtime = {
    list: () =>
      [...sandboxes].map(([id, s]) => ({
        id,
        status: s.status,
        createdAt: "",
      })),
    get: async (id: string) => ({ id, ...requireSandbox(id) }),
    create: async (_spec: unknown, opts: { id?: string } = {}) => {
      const id = opts.id ?? "generated";
      sandboxes.set(id, { status: "running", urls: [PI_URL] });
      return { id, status: "running" as const };
    },
    pause: async (id: string) => {
      requireSandbox(id).status = "paused";
      return {};
    },
    resume: async (id: string) => {
      requireSandbox(id).status = "running";
      return { id, ...requireSandbox(id) };
    },
    destroy: async (id: string) => {
      requireSandbox(id);
      sandboxes.delete(id);
    },
  };
  return { sandboxes, runtime };
}

/** A fake `McpServer` that just records each `registerTool` handler, keyed
 * by tool name — enough to call the tools the way `/mcp` does. */
class FakeMcpServer {
  tools = new Map<string, (args: Record<string, unknown>) => Promise<Result>>();
  registerTool(
    name: string,
    _def: unknown,
    handler: (args: Record<string, unknown>) => Promise<Result>,
  ) {
    this.tools.set(name, handler);
  }
}

interface Result {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

async function call(
  server: FakeMcpServer,
  name: string,
  args: Record<string, unknown> = {},
) {
  const handler = server.tools.get(name);
  if (!handler) throw new Error(`tool ${name} not registered`);
  const result = await handler(args);
  const parsed = JSON.parse(result.content[0]?.text ?? "null");
  return { parsed, isError: result.isError === true };
}

function setup() {
  const fake = fakeRuntime();
  const jobs = new JobService({ store: new InMemoryJobStore() });
  const container = {
    control,
    runtime: fake.runtime,
    jobs,
  } as unknown as ServerContainer;
  return { ...fake, jobs, container };
}

function serverFor(container: ServerContainer, user: AuthUser) {
  const server = new FakeMcpServer();
  registerLaunchpadTools(
    server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
    container,
    user,
  );
  return server;
}

/** Let a background (unpooled) launch/wake job settle. */
async function settleLatestJob(jobs: JobService, userId: string, id: string) {
  for (let i = 0; i < 50; i++) {
    const jobId = control.workspaceService.getOwned(id, userId).jobId;
    if (!jobId) return;
    const { status } = jobs.get(jobId);
    if (status !== "queued" && status !== "running") return;
    await Bun.sleep(5);
  }
  throw new Error(`workspace ${id} never settled`);
}

let userSeq = 0;
function newUser(): AuthUser {
  userSeq++;
  const user = control.userService.upsertFromLogin(
    `gh-mcp-launchpad-${userSeq}`,
    `mcpuser${userSeq}`,
    `mcpuser${userSeq}@example.test`,
    "",
  );
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    avatarUrl: "",
  };
}

function starterInput(overrides: Partial<StarterInput> = {}): StarterInput {
  return {
    title: "Edit the site",
    description: "Change copy and images",
    recipe: {
      source: { image: "dev-base" },
      resources: { vcpus: 2, memoryMb: 4096 },
    },
    services: [{ id: "agent", label: "Assistant", target: { port: "pi" } }],
    ...overrides,
  };
}

// ── tests ───────────────────────────────────────────────────────────────────

describe("launchpad_catalog", () => {
  test("lists published starters, concise", async () => {
    const { container } = setup();
    const user = newUser();
    const owner = { type: "user" as const, id: user.id };
    control.starterService.create(owner, starterInput({ title: "Shown" }));
    control.starterService.create(
      owner,
      starterInput({ title: "Draft", published: false }),
    );

    const { parsed } = await call(
      serverFor(container, user),
      "launchpad_catalog",
    );
    expect(parsed).toEqual([
      {
        id: expect.any(String),
        title: "Shown",
        description: "Change copy and images",
        services: [{ label: "Assistant" }],
      },
    ]);
  });
});

describe("launchpad_launch", () => {
  test("launches a starter into a workspace, reaching ready", async () => {
    const { container, jobs } = setup();
    const user = newUser();
    const starter = control.starterService.create(
      { type: "user", id: user.id },
      starterInput(),
    );
    const server = serverFor(container, user);

    const { parsed } = await call(server, "launchpad_launch", {
      starterId: starter.id,
      title: "  My Workspace  ",
    });
    expect(parsed.title).toBe("My Workspace");
    expect(parsed.phase).toBe("preparing");
    expect(parsed.console).toBe(`/launchpad/w/${parsed.id}`);

    await settleLatestJob(jobs, user.id, parsed.id);
    const { parsed: detail } = await call(server, "launchpad_workspace", {
      workspaceId: parsed.id,
    });
    expect(detail.phase).toBe("ready");
    expect(detail.services[0]).toMatchObject({ label: "Assistant" });
  });

  test("an unknown starter is a friendly tool error, not a thrown exception", async () => {
    const { container } = setup();
    const user = newUser();
    const { parsed, isError } = await call(
      serverFor(container, user),
      "launchpad_launch",
      { starterId: "does-not-exist" },
    );
    expect(isError).toBe(true);
    expect(parsed.error).toBe("NOT_FOUND");
  });
});

describe("launchpad_workspaces", () => {
  test("lists the caller's workspaces only", async () => {
    const { container, jobs } = setup();
    const owner = newUser();
    const stranger = newUser();
    const starter = control.starterService.create(
      { type: "user", id: owner.id },
      starterInput(),
    );
    const ownerServer = serverFor(container, owner);
    const { parsed: launched } = await call(ownerServer, "launchpad_launch", {
      starterId: starter.id,
    });
    await settleLatestJob(jobs, owner.id, launched.id);

    const { parsed: ownerList } = await call(
      ownerServer,
      "launchpad_workspaces",
    );
    expect(ownerList).toEqual([
      expect.objectContaining({ id: launched.id, phase: "ready" }),
    ]);

    const { parsed: strangerList } = await call(
      serverFor(container, stranger),
      "launchpad_workspaces",
    );
    expect(strangerList).toEqual([]);
  });
});

describe("launchpad_workspace", () => {
  test("another user's workspace is a not-found tool error", async () => {
    const { container, jobs } = setup();
    const owner = newUser();
    const stranger = newUser();
    const starter = control.starterService.create(
      { type: "user", id: owner.id },
      starterInput(),
    );
    const ownerServer = serverFor(container, owner);
    const { parsed: launched } = await call(ownerServer, "launchpad_launch", {
      starterId: starter.id,
    });
    await settleLatestJob(jobs, owner.id, launched.id);

    const { parsed, isError } = await call(
      serverFor(container, stranger),
      "launchpad_workspace",
      { workspaceId: launched.id },
    );
    expect(isError).toBe(true);
    expect(parsed.error).toBe("NOT_FOUND");
  });
});

describe("launchpad_workspace_action", () => {
  async function readyWorkspace() {
    const env = setup();
    const user = newUser();
    const starter = control.starterService.create(
      { type: "user", id: user.id },
      starterInput(),
    );
    const server = serverFor(env.container, user);
    const { parsed: launched } = await call(server, "launchpad_launch", {
      starterId: starter.id,
    });
    await settleLatestJob(env.jobs, user.id, launched.id);
    return { ...env, user, server, id: launched.id };
  }

  test("sleep then wake round-trips through ready → sleeping → ready", async () => {
    const { server, jobs, user, id } = await readyWorkspace();

    const { parsed: asleep } = await call(
      server,
      "launchpad_workspace_action",
      {
        workspaceId: id,
        action: "sleep",
      },
    );
    expect(asleep.phase).toBe("sleeping");

    const { parsed: waking } = await call(
      server,
      "launchpad_workspace_action",
      {
        workspaceId: id,
        action: "wake",
      },
    );
    expect(waking.phase).toBe("starting");
    await settleLatestJob(jobs, user.id, id);

    const { parsed: detail } = await call(server, "launchpad_workspace", {
      workspaceId: id,
    });
    expect(detail.phase).toBe("ready");
  });

  test("a stranger acting on someone else's workspace gets a not-found error", async () => {
    const { container, id } = await readyWorkspace();
    const stranger = newUser();
    const { parsed, isError } = await call(
      serverFor(container, stranger),
      "launchpad_workspace_action",
      { workspaceId: id, action: "sleep" },
    );
    expect(isError).toBe(true);
    expect(parsed.error).toBe("NOT_FOUND");
  });
});
