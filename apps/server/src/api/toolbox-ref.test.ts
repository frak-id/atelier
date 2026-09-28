/**
 * `toolboxForRef`: a toolbox moved to another owner must still be found from
 * artifacts/selectors named after its PREVIOUS owner (refs are immutable),
 * while a digest ref never gets claimed by a newer same-named toolbox.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlContainer } from "../control/index.ts";
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

/** `toolboxForRef` only reads `container.control`. */
const container = () =>
  ({ control }) as unknown as Parameters<typeof mod.toolboxForRef>[0];

describe("toolboxForRef", () => {
  test("follows a moved toolbox through its old artifact names", () => {
    const team = control.organizationService.create("Team", "ref-team");
    const tb = control.toolboxService.create(
      { type: "user", id: "ref-user" },
      { slug: "pi-web", description: "d", build: ["x"], paths: ["~/.x"] },
    );
    const oldRef = "toolsets/tb/user/ref-user/pi-web@sha256:11";
    control.toolboxVersionService.recordBuilt(tb.id, {
      ref: oldRef,
      recipeFingerprint: "fp",
    });
    control.ownershipTransferService.execute(
      { type: "user", id: "ref-user" },
      team.id,
      { secrets: [], policy: [], toolboxes: [tb.id], starters: [] },
    );

    for (const ref of [
      oldRef,
      "tb/user/ref-user/pi-web",
      "toolsets/tb/user/ref-user/pi-web",
      `tb/org/${team.id}/pi-web`,
    ]) {
      expect(mod.toolboxForRef(container(), ref)?.id).toBe(tb.id);
    }
    expect(mod.toolboxForRef(container(), "tb/user/ref-user/nope")).toBe(
      undefined,
    );
    expect(mod.toolboxForRef(container(), "not-a-toolbox")).toBe(undefined);

    // A new personal toolbox reusing the slug owns the bare name again, but
    // the moved toolbox keeps its exact recorded artifact.
    const fresh = control.toolboxService.create(
      { type: "user", id: "ref-user" },
      { slug: "pi-web", description: "d", build: ["x"], paths: ["~/.x"] },
    );
    expect(mod.toolboxForRef(container(), "tb/user/ref-user/pi-web")?.id).toBe(
      fresh.id,
    );
    expect(mod.toolboxForRef(container(), oldRef)?.id).toBe(tb.id);
  });
});
