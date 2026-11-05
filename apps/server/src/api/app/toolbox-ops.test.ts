/**
 * Toolbox artifacts are named after the toolbox id (`tb/<id>`), so a toolbox
 * is found from its selector or artifact ref whatever org it lives in, and a
 * spawn's toolbox files merge in before secrets resolve.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolboxArtifactName } from "@atelier/spec";
import type { ControlContainer } from "../../control/index.ts";
import { ForbiddenError, ValidationError } from "../../shared/errors.ts";
import type * as ToolboxOpsModule from "./toolbox-ops.ts";

let dataDir: string;
let control: ControlContainer;
let mod: typeof ToolboxOpsModule;
let ops: InstanceType<typeof ToolboxOpsModule.ToolboxOps>;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "atelier-toolbox-ref-test-"));
  process.env.DATA_DIR = dataDir;
  process.env.MIGRATIONS_DIR ??= join(import.meta.dir, "../../../drizzle");
  const { initDatabase } = await import("../../control/db/client.ts");
  await initDatabase();
  const { createControlContainer } = await import("../../control/index.ts");
  control = createControlContainer();
  mod = await import("./toolbox-ops.ts");
  // Files-only/process-only toolboxes build nothing, so no runtime is read.
  ops = new mod.ToolboxOps({ control, runtime: {}, jobs: {} } as never);
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const input = { description: "d", build: [], paths: [] };

describe("ToolboxOps.forRef", () => {
  test("finds a toolbox from its selector and artifact refs, moved or not", () => {
    const team = control.organizationService.create("Team", "ref-team");
    const personal = control.organizationService.create("me", "ref-me", true);
    const tb = control.toolboxService.create(personal.id, {
      ...input,
      slug: "pi-web",
    });
    const name = toolboxArtifactName(tb);
    expect(name).toBe(`tb/${tb.id}`);

    control.ownershipTransferService.execute(personal.id, team.id, {
      secrets: [],
      toolboxes: [tb.id],
    });

    for (const ref of [
      name,
      `toolsets/${name}`,
      `registry.test:5000/toolsets/${name}@sha256:11`,
    ]) {
      expect(ops.forRef(ref)?.id).toBe(tb.id);
    }
    expect(ops.forRef("tb/nope")).toBeUndefined();
    // Names from before artifacts were keyed on the id don't parse.
    expect(ops.forRef(`tb/org/${team.id}/pi-web`)).toBeUndefined();
    expect(ops.forRef("not-a-toolbox")).toBeUndefined();
  });
});

describe("ToolboxOps.resolveForSpawn", () => {
  test("applies the org's auto-inject toolboxes and picked ones, files-only included", async () => {
    const org = control.organizationService.create("Spawn", "ref-spawn");
    const stranger = control.organizationService.create("Other", "ref-other");
    control.userService.upsertFromLogin("ref-u", "ref-u", "u@x.test", "");
    control.orgMemberService.addMember(org.id, "ref-u", "member");

    const keyFile = {
      path: "/home/dev/.config/x/key",
      content: { $secret: "X_KEY" },
      mode: "600",
      owner: "dev",
    };
    const auto = control.toolboxService.create(org.id, {
      ...input,
      slug: "org-defaults",
      files: [keyFile],
      harness: "pi",
    });
    const picked = control.toolboxService.create(org.id, {
      ...input,
      slug: "picked",
      autoInject: false,
      processes: [{ name: "code", command: "code-server" }],
    });
    const foreign = control.toolboxService.create(stranger.id, {
      ...input,
      slug: "foreign",
      autoInject: false,
    });

    const { refs, applied } = await ops.resolveForSpawn({
      orgId: org.id,
      userId: "ref-u",
      selectors: [toolboxArtifactName(picked)],
      toolsets: [],
    });
    expect(refs).toEqual([]);
    expect(applied.map((c) => c.id)).toEqual([auto.id, picked.id]);
    expect(mod.toolboxHarness(applied)).toBe("pi");
    expect(mod.toolboxSurface(applied).processes).toHaveLength(1);

    // The toolbox's files land in the spec (secret ref intact, resolved later
    // by enrichment); the spec's own file at the same path wins.
    const base = {
      source: { image: "dev-base" },
      resources: { vcpus: 1, memoryMb: 512 },
    };
    expect(mod.withToolboxFiles(base, applied).files).toEqual([keyFile]);
    const own = { path: keyFile.path, content: "mine" };
    expect(
      mod.withToolboxFiles({ ...base, files: [own] }, applied).files,
    ).toEqual([own]);

    // A selector for another org's toolbox is refused.
    await expect(
      ops.resolveForSpawn({
        orgId: org.id,
        userId: "ref-u",
        selectors: [toolboxArtifactName(foreign)],
        toolsets: [],
      }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe("ToolboxOps pin / publish / deleteVersion", () => {
  /** A runtime whose artifacts are private until published. */
  function fakeRuntime() {
    const priv = new Set<string>();
    return {
      priv,
      runtime: {
        getToolsetEntry: (ref: string) => ({ private: priv.has(ref) }),
        publishToolset: (ref: string) => {
          priv.delete(ref);
          return { private: false };
        },
      },
    };
  }

  function setup(slug: string) {
    const org = control.organizationService.create("Pin", `pin-${slug}`);
    const userId = `pin-u-${slug}`;
    control.userService.upsertFromLogin(userId, userId, `${userId}@x.test`, "");
    control.orgMemberService.addMember(org.id, userId, "member");
    const tb = control.toolboxService.create(org.id, { ...input, slug });
    const other = control.toolboxService.create(org.id, {
      ...input,
      slug: `${slug}-other`,
    });
    const fake = fakeRuntime();
    const pinOps = new mod.ToolboxOps({
      control,
      runtime: fake.runtime,
      jobs: {},
    } as never);
    const version = (toolboxId: string, ref: string) => {
      const v = control.toolboxVersionService.create(toolboxId, {
        ref,
        description: "d",
        provenance: { kind: "built", recipeHash: "h" },
        recipeFingerprint: "fp",
      });
      return v;
    };
    return { tb, other, userId, fake, pinOps, version };
  }

  test("a private capture cannot be pinned until it is published", () => {
    const { tb, userId, fake, pinOps, version } = setup("guard");
    const v = version(tb.id, "toolsets/tb/guard@sha256:1");
    fake.priv.add(v.ref);
    expect(() => pinOps.pin(userId, tb.id, v.id)).toThrow(ValidationError);

    expect(pinOps.publish(userId, tb.id, v.id)).toEqual({
      versionId: v.id,
      private: false,
    });
    expect(pinOps.pin(userId, tb.id, v.id)).toBe(v.id);
    expect(control.toolboxService.getActiveVersionId(tb.id)).toBe(v.id);
    expect(pinOps.pin(userId, tb.id, null)).toBeNull();
  });

  test("a version of another toolbox is refused everywhere", () => {
    const { tb, other, userId, pinOps, version } = setup("owner");
    const foreign = version(other.id, "toolsets/tb/other@sha256:2");
    expect(() => pinOps.pin(userId, tb.id, foreign.id)).toThrow(
      ValidationError,
    );
    expect(() => pinOps.publish(userId, tb.id, foreign.id)).toThrow(
      ValidationError,
    );
    expect(() => pinOps.deleteVersion(userId, tb.id, foreign.id)).toThrow(
      ValidationError,
    );
  });

  test("the pinned version cannot be deleted, an unpinned one can", () => {
    const { tb, userId, pinOps, version } = setup("del");
    const v = version(tb.id, "toolsets/tb/del@sha256:3");
    pinOps.pin(userId, tb.id, v.id);
    expect(() => pinOps.deleteVersion(userId, tb.id, v.id)).toThrow(
      ValidationError,
    );
    pinOps.pin(userId, tb.id, null);
    pinOps.deleteVersion(userId, tb.id, v.id);
    expect(control.toolboxVersionService.find(v.id)).toBeUndefined();
  });

  test("a non-member of the toolbox's org is refused", () => {
    const { tb, pinOps } = setup("acl");
    expect(() => pinOps.pin("not-a-member", tb.id, null)).toThrow(
      ForbiddenError,
    );
  });
});
