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
import type { ControlContainer } from "../control/index.ts";
import { ForbiddenError } from "../shared/errors.ts";
import type * as ContainerModule from "./container.ts";

let dataDir: string;
let control: ControlContainer;
let mod: typeof ContainerModule;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "atelier-toolbox-ref-test-"));
  process.env.DATA_DIR = dataDir;
  process.env.MIGRATIONS_DIR ??= join(import.meta.dir, "../../drizzle");
  const { initDatabase } = await import("../control/db/client.ts");
  await initDatabase();
  const { createControlContainer } = await import("../control/index.ts");
  control = createControlContainer();
  mod = await import("./container.ts");
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

/** The helpers under test only read `container.control` (and, when a toolbox
 * needs a toolset, `runtime`, which these toolboxes never reach). */
const container = () =>
  ({ control }) as unknown as Parameters<typeof mod.toolboxForRef>[0];

const input = { description: "d", build: [], paths: [] };

describe("toolboxForRef", () => {
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
      expect(mod.toolboxForRef(container(), ref)?.id).toBe(tb.id);
    }
    expect(mod.toolboxForRef(container(), "tb/nope")).toBeUndefined();
    // Names from before artifacts were keyed on the id don't parse.
    expect(
      mod.toolboxForRef(container(), `tb/org/${team.id}/pi-web`),
    ).toBeUndefined();
    expect(mod.toolboxForRef(container(), "not-a-toolbox")).toBeUndefined();
  });
});

describe("resolveSpawnToolboxes", () => {
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

    // No `runtime` on the container: files-only/process-only toolboxes have
    // no paths, so nothing is built.
    const { refs, applied } = await mod.resolveSpawnToolboxes(container(), {
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
      mod.resolveSpawnToolboxes(container(), {
        orgId: org.id,
        userId: "ref-u",
        selectors: [toolboxArtifactName(foreign)],
        toolsets: [],
      }),
    ).rejects.toThrow(ForbiddenError);
  });
});
