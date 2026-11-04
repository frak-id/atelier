/**
 * Ownership transfers against a real control DB: the preview (conflicts,
 * notes), the move itself (ids kept, pins kept), and the all-or-nothing
 * validation of a selection.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolboxOwner } from "@atelier/spec";
import { ConflictError, ValidationError } from "../../../shared/errors.ts";
import type { ControlContainer } from "../../index.ts";
import type { TransferSelection } from "./index.ts";

let dataDir: string;
let control: ControlContainer;
let seq = 0;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "atelier-transfer-test-"));
  process.env.DATA_DIR = dataDir;
  process.env.MIGRATIONS_DIR ??= join(import.meta.dir, "../../../../drizzle");
  const { initDatabase } = await import("../../db/client.ts");
  await initDatabase();
  const { createControlContainer } = await import("../../index.ts");
  control = createControlContainer();
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function org(): ToolboxOwner & { type: "org" } {
  seq++;
  const created = control.organizationService.create(
    `Org ${seq}`,
    `transfer-org-${seq}`,
  );
  return { type: "org", id: created.id };
}

function user(): ToolboxOwner & { type: "user" } {
  seq++;
  return { type: "user", id: `transfer-user-${seq}` };
}

function toolbox(owner: ToolboxOwner, slug: string) {
  return control.toolboxService.create(owner, {
    slug,
    description: slug,
    build: ["echo hi"],
    paths: ["~/.x"],
  });
}

function selection(
  partial: Partial<TransferSelection> = {},
): TransferSelection {
  return { secrets: [], policy: [], toolboxes: [], ...partial };
}

const service = () => control.ownershipTransferService;

describe("OwnershipTransferService.preview", () => {
  test("lists an org's secrets, policy and toolboxes", async () => {
    const from = org();
    const to = org();
    await control.secretService.set(from.id, "API_KEY", "v");
    control.orgPolicyService.set(from.id, { env: { A: "1" } });
    toolbox(from, "vscode");

    const preview = service().preview(from, to.id);
    expect(preview.secrets.map((s) => s.label)).toEqual(["API_KEY"]);
    expect(preview.policy).toHaveLength(1);
    expect(preview.toolboxes.map((t) => t.label)).toEqual(["vscode"]);
    const items = Object.values(preview).flat();
    expect(items.every((item) => item.blocker === undefined)).toBe(true);
  });

  test("a personal scope has no secrets or policy", () => {
    const from = user();
    toolbox(from, "pi-web");
    const preview = service().preview(from, org().id);
    expect(preview.secrets).toEqual([]);
    expect(preview.policy).toEqual([]);
    expect(preview.toolboxes).toHaveLength(1);
  });

  test("flags name, slug and policy clashes in the target", async () => {
    const from = org();
    const to = org();
    await control.secretService.set(from.id, "TOKEN", "a");
    await control.secretService.set(to.id, "TOKEN", "b");
    control.orgPolicyService.set(from.id, {});
    control.orgPolicyService.set(to.id, {});
    toolbox(from, "browser");
    toolbox(to, "browser");

    const preview = service().preview(from, to.id);
    expect(preview.secrets[0]?.blocker).toContain("already exists");
    expect(preview.policy[0]?.blocker).toContain("already has a policy");
    expect(preview.toolboxes[0]?.blocker).toContain("already exists");
  });

  test("the pinned-toolbox veto only applies to pinned toolboxes", () => {
    const from = user();
    const pinned = toolbox(from, "pinned");
    toolbox(from, "unpinned");
    const version = control.toolboxVersionService.create(pinned.id, {
      ref: `toolsets/tb/user/${from.id}/pinned@sha256:aa`,
      description: "capture",
      provenance: { kind: "captured", capturedFrom: "sb", capturedBy: "u" },
      recipeFingerprint: "fp",
    });
    control.toolboxService.setActiveVersionId(pinned.id, version.id);

    const seen: string[] = [];
    const preview = service().preview(from, org().id, {
      pinnedToolboxBlocker: (ref) => {
        seen.push(ref);
        return "private";
      },
    });
    expect(seen).toEqual([version.ref]);
    const byLabel = new Map(preview.toolboxes.map((t) => [t.label, t]));
    expect(byLabel.get("pinned")?.blocker).toBe("private");
    expect(byLabel.get("pinned")?.notes.join(" ")).toContain("v1");
    expect(byLabel.get("unpinned")?.blocker).toBeUndefined();
  });

  test("rejects moving an org onto itself", () => {
    const same = org();
    expect(() => service().preview(same, same.id)).toThrow(ValidationError);
  });
});

describe("OwnershipTransferService.execute", () => {
  test("moves the selected records and keeps their ids + pins", async () => {
    const from = org();
    const to = org();
    const secret = await control.secretService.set(from.id, "KEEP", "v");
    const moved = await control.secretService.set(from.id, "MOVE", "secret");
    control.orgPolicyService.set(from.id, { env: { A: "1" } });
    const tb = toolbox(from, "tools");
    const version = control.toolboxVersionService.create(tb.id, {
      ref: `toolsets/tb/org/${from.id}/tools@sha256:bb`,
      description: "v",
      provenance: { kind: "captured", capturedFrom: "sb", capturedBy: "u" },
      recipeFingerprint: "fp",
    });
    control.toolboxService.setActiveVersionId(tb.id, version.id);
    const preview = service().preview(from, to.id);

    const result = service().execute(
      from,
      to.id,
      selection({
        secrets: [moved.id],
        policy: preview.policy.map((p) => p.id),
        toolboxes: [tb.id],
      }),
    );

    expect(result.moved).toEqual({ secrets: 1, policy: 1, toolboxes: 1 });
    expect(control.secretService.list(from.id).map((s) => s.id)).toEqual([
      secret.id,
    ]);
    expect(control.secretService.list(to.id).map((s) => s.id)).toEqual([
      moved.id,
    ]);
    // Encrypted value moved verbatim, still decryptable in the target.
    expect(await control.secretService.resolve(to.id, "MOVE")).toBe("secret");
    expect(control.orgPolicyService.getByOrgId(from.id)).toBeUndefined();
    expect(control.orgPolicyService.getByOrgId(to.id)?.fragment).toEqual({
      env: { A: "1" },
    });
    const movedTb = control.toolboxService.get(tb.id);
    expect(movedTb.ownerType).toBe("org");
    expect(movedTb.ownerId).toBe(to.id);
    expect(control.toolboxService.getActiveVersionId(tb.id)).toBe(version.id);
  });

  test("execute enforces the pinned-toolbox veto, not just preview", () => {
    const from = user();
    const to = org();
    const pinned = toolbox(from, "private-pin");
    const version = control.toolboxVersionService.create(pinned.id, {
      ref: `toolsets/tb/user/${from.id}/private-pin@sha256:cc`,
      description: "capture",
      provenance: { kind: "captured", capturedFrom: "sb", capturedBy: "u" },
      recipeFingerprint: "fp",
    });
    control.toolboxService.setActiveVersionId(pinned.id, version.id);

    expect(() =>
      service().execute(from, to.id, selection({ toolboxes: [pinned.id] }), {
        pinnedToolboxBlocker: () => "private capture",
      }),
    ).toThrow(ConflictError);
    expect(control.toolboxService.get(pinned.id).ownerId).toBe(from.id);
  });

  test("rejects blocked, foreign and empty selections, writing nothing", async () => {
    const from = org();
    const to = org();
    await control.secretService.set(from.id, "DUP", "a");
    await control.secretService.set(to.id, "DUP", "b");
    const free = toolbox(from, "free");
    const [dup] = service().preview(from, to.id).secrets;
    const foreign = toolbox(org(), "foreign");

    expect(() =>
      service().execute(
        from,
        to.id,
        selection({ secrets: [dup?.id ?? ""], toolboxes: [free.id] }),
      ),
    ).toThrow(ConflictError);
    expect(() =>
      service().execute(from, to.id, selection({ toolboxes: [foreign.id] })),
    ).toThrow(ValidationError);
    expect(() => service().execute(from, to.id, selection())).toThrow(
      ValidationError,
    );
    // Nothing moved by any of the rejected calls.
    expect(control.toolboxService.get(free.id).ownerId).toBe(from.id);
    expect(control.toolboxService.get(foreign.id).ownerId).not.toBe(to.id);
  });
});
