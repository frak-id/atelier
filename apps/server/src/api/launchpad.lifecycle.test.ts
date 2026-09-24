/**
 * The Launchpad lifecycle against a real control DB + job queue and a fake
 * runtime: phases, pruning, the retry paths, sleep/wake, delete races and
 * launch authorization.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CreateSandboxRequest,
  SandboxStatus,
  SandboxUrl,
  StarterInput,
} from "@atelier/spec";
import type { AuthUser, ControlContainer } from "../control/index.ts";
import { InMemoryJobStore, JobService } from "../runtime/index.ts";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../shared/errors.ts";
import type * as LifecycleModule from "./launchpad.lifecycle.ts";

let dataDir: string;
let control: ControlContainer;
let Lifecycle: typeof LifecycleModule.LaunchpadLifecycle;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "atelier-launchpad-lifecycle-"));
  process.env.DATA_DIR = dataDir;
  process.env.MIGRATIONS_DIR ??= join(import.meta.dir, "../../drizzle");
  const { initDatabase } = await import("../control/db/client.ts");
  await initDatabase();
  const { createControlContainer } = await import("../control/index.ts");
  control = createControlContainer();
  ({ LaunchpadLifecycle: Lifecycle } = await import(
    "./launchpad.lifecycle.ts"
  ));
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

// ── fakes ───────────────────────────────────────────────────────────────────

interface FakeSandbox {
  status: SandboxStatus;
  urls: SandboxUrl[];
}

/** Just enough runtime for the lifecycle: an in-memory record map. */
function fakeRuntime() {
  const sandboxes = new Map<string, FakeSandbox>();
  const started: string[] = [];
  const require = (id: string) => {
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
    get: async (id: string) => ({ id, ...require(id) }),
    pause: async (id: string) => {
      require(id).status = "paused";
      return {};
    },
    resume: async (id: string) => {
      require(id).status = "running";
      return { id, ...require(id) };
    },
    destroy: async (id: string) => {
      require(id);
      sandboxes.delete(id);
    },
    processAction: async (id: string, name: string) => {
      require(id);
      started.push(name);
    },
  };
  return { sandboxes, started, runtime };
}

const PI_URL: SandboxUrl = {
  name: "pi",
  url: "https://pi.example.test",
  processes: ["pi-web"],
  ready: false,
};

function setup(options: { failCreate?: boolean } = {}) {
  const fake = fakeRuntime();
  const jobs = new JobService({ store: new InMemoryJobStore() });
  const created: CreateSandboxRequest[] = [];
  const lifecycle = new Lifecycle({
    control,
    // The fake covers exactly the methods the lifecycle calls.
    runtime: fake.runtime as unknown as ConstructorParameters<
      typeof Lifecycle
    >[0]["runtime"],
    jobs,
    createSandbox: async (_user, request, sandboxId) => {
      created.push(request);
      await Bun.sleep(1); // a real create is never synchronous
      if (options.failCreate) throw new Error("image pull failed");
      fake.sandboxes.set(sandboxId, { status: "running", urls: [PI_URL] });
      return { id: sandboxId };
    },
    resumeBody: async () => ({}),
  });
  return { ...fake, jobs, lifecycle, created };
}

/** Let the background (unpooled) jobs settle. */
async function settle(jobs: JobService, jobId: string | undefined) {
  if (!jobId) return;
  for (let i = 0; i < 50; i++) {
    const { status } = jobs.get(jobId);
    if (status !== "queued" && status !== "running") return;
    await Bun.sleep(5);
  }
  throw new Error(`job ${jobId} never settled`);
}

let userSeq = 0;
function newUser(): AuthUser {
  userSeq++;
  const user = control.userService.upsertFromLogin(
    `gh-${userSeq}`,
    `user${userSeq}`,
    `user${userSeq}@example.test`,
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

/** The workspace's latest lifecycle job id, straight from its row. */
function latestJob(userId: string, id: string): string | undefined {
  return control.workspaceService.getOwned(id, userId).jobId;
}

// ── tests ───────────────────────────────────────────────────────────────────

describe("launch", () => {
  test("launches the recipe, autostarts services and reaches ready", async () => {
    const { lifecycle, jobs, created, started } = setup();
    const user = newUser();
    const starter = control.starterService.create(
      { type: "user", id: user.id },
      starterInput(),
    );

    const view = lifecycle.launch(user, starter.id, { title: "  Hero  " });
    expect(view.title).toBe("Hero");
    expect(view.phase).toBe("preparing");

    await settle(jobs, latestJob(user.id, view.id));
    expect(created[0]?.annotations?.["atelier.dev/launchpad-starter"]).toBe(
      starter.id,
    );
    expect(started).toEqual(["pi-web"]);
    const [listed] = lifecycle.list(user.id);
    expect(listed?.phase).toBe("ready");
  });

  test("a failed launch is `failed` with the job's error, and retry relaunches", async () => {
    const { lifecycle, jobs } = setup({ failCreate: true });
    const user = newUser();
    const starter = control.starterService.create(
      { type: "user", id: user.id },
      starterInput(),
    );
    const { id } = lifecycle.launch(user, starter.id, {});
    await settle(jobs, latestJob(user.id, id));
    const failed = lifecycle.list(user.id)[0];
    expect(failed?.phase).toBe("failed");
    expect(failed?.error).toBe("image pull failed");

    const firstJob = latestJob(user.id, id);
    lifecycle.retry(user, id);
    // No record landed: a fresh launch job with the same id.
    expect(latestJob(user.id, id)).not.toBe(firstJob);
    expect(jobs.get(latestJob(user.id, id) ?? "").kind).toBe("sandbox-create");
  });

  test("a draft is launchable by its authors only — also on retry", async () => {
    const { lifecycle, jobs } = setup({ failCreate: true });
    const author = newUser();
    const member = newUser();
    const org = control.organizationService.create("Acme", `acme-${userSeq}`);
    control.orgMemberService.addMember(org.id, author.id, "admin");
    control.orgMemberService.addMember(org.id, member.id, "member");
    const starter = control.starterService.create(
      { type: "org", id: org.id },
      starterInput({ published: false }),
    );

    expect(() => lifecycle.launch(member, starter.id, {})).toThrow(
      ForbiddenError,
    );

    // Launched while published, failed, then unpublished: the member's
    // retry must hit the same draft rule as a launch.
    control.starterService.update(starter.id, { published: true });
    const { id } = lifecycle.launch(member, starter.id, {});
    await settle(jobs, latestJob(member.id, id));
    control.starterService.update(starter.id, { published: false });
    expect(() => lifecycle.retry(member, id)).toThrow(ForbiddenError);
  });

  test("retry after the starter was deleted explains why it can't", async () => {
    const { lifecycle, jobs } = setup({ failCreate: true });
    const user = newUser();
    const starter = control.starterService.create(
      { type: "user", id: user.id },
      starterInput(),
    );
    const { id } = lifecycle.launch(user, starter.id, {});
    await settle(jobs, latestJob(user.id, id));
    control.starterService.delete(starter.id);
    expect(() => lifecycle.retry(user, id)).toThrow(/no longer exists/);
  });
});

describe("sleep, wake, delete", () => {
  async function readyWorkspace() {
    const env = setup();
    const user = newUser();
    const starter = control.starterService.create(
      { type: "user", id: user.id },
      starterInput(),
    );
    const { id } = env.lifecycle.launch(user, starter.id, {});
    await settle(env.jobs, latestJob(user.id, id));
    return { ...env, user, id };
  }

  test("sleep → sleeping (and floats to the top), wake → ready", async () => {
    const { lifecycle, jobs, user, id } = await readyWorkspace();
    const before = control.workspaceService.getOwned(id, user.id).updatedAt;
    await Bun.sleep(5);

    expect((await lifecycle.sleep(id, user.id)).phase).toBe("sleeping");
    expect(
      control.workspaceService.getOwned(id, user.id).updatedAt > before,
    ).toBe(true);
    await expect(lifecycle.sleep(id, user.id)).rejects.toThrow(ConflictError);

    expect(lifecycle.wake(id, user.id).phase).toBe("starting");
    await settle(jobs, latestJob(user.id, id));
    expect(lifecycle.list(user.id)[0]?.phase).toBe("ready");
  });

  test("a sandbox destroyed elsewhere is pruned on read", async () => {
    const { lifecycle, sandboxes, user, id } = await readyWorkspace();
    sandboxes.delete(id);
    expect(lifecycle.list(user.id)).toEqual([]);
    expect(() => control.workspaceService.getOwned(id, user.id)).toThrow(
      NotFoundError,
    );
  });

  test("delete tolerates a sandbox destroyed concurrently", async () => {
    const { lifecycle, runtime, sandboxes, user, id } = await readyWorkspace();
    // Gone between the lifecycle's look and its destroy call.
    const destroy = runtime.destroy;
    runtime.destroy = async (target: string) => {
      sandboxes.delete(target);
      return destroy(target);
    };
    await lifecycle.delete(id, user.id);
    expect(() => control.workspaceService.getOwned(id, user.id)).toThrow(
      NotFoundError,
    );
  });

  test("delete refuses while starting, and someone else's is a 404", async () => {
    const { lifecycle, jobs, user, id } = await readyWorkspace();
    await lifecycle.sleep(id, user.id);
    lifecycle.wake(id, user.id);
    await expect(lifecycle.delete(id, user.id)).rejects.toThrow(ConflictError);
    await settle(jobs, latestJob(user.id, id));

    const stranger = newUser();
    await expect(lifecycle.delete(id, stranger.id)).rejects.toThrow(
      NotFoundError,
    );
    await lifecycle.delete(id, user.id);
    expect(lifecycle.list(user.id)).toEqual([]);
  });
});

describe("catalog", () => {
  test("lists published starters only, without the recipe", () => {
    const { lifecycle } = setup();
    const user = newUser();
    const owner = { type: "user" as const, id: user.id };
    control.starterService.create(owner, starterInput({ title: "Shown" }));
    control.starterService.create(
      owner,
      starterInput({ title: "Draft", published: false }),
    );
    const catalog = lifecycle.catalog(user.id);
    expect(catalog.map((s) => s.title)).toEqual(["Shown"]);
    expect(catalog[0]).not.toHaveProperty("recipe");
    expect(catalog[0]?.ownerLabel).toBe("Personal");
  });
});
