/**
 * `bootSandbox`'s fresh-volume contract — the server half of sandbox-boot.sh's
 * mkfs guard. The guest may only format the workspace device when the pod
 * carries `VM.DATA_FRESH_ENV=1`, so the server must set it for a blank PVC it
 * creates in this boot and NEVER for a resumed or snapshot-cloned one (those
 * carry user data). Plus the rollback edge: a failed from-scratch resume must
 * drop its blank PVC, or the retry would reuse it unmarked and the guest would
 * refuse the unformatted disk forever — but ONLY a PVC this boot actually
 * created (confirmed create, deleted by uid): a same-name PVC that already
 * existed may hold a workspace.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { SandboxSpec } from "@atelier/spec";
import { VM } from "@frak/atelier-shared/constants";

process.env.ATELIER_SERVER_MODE = "mock";

const { bootSandbox } = await import("./boot.ts");
const { kubeClient, KubeApiError } = await import("./kube/index.ts");
type KubeDeleteOptions = import("./kube/kube.client.ts").KubeDeleteOptions;
const { AgentClient } = await import("./agent/index.ts");
type BootInput = import("./boot.ts").BootInput;
type KubeResource = import("./kube/index.ts").KubeResource;

const ID = "sbfresh";
const spec: SandboxSpec = {
  source: { image: "registry.test/base:1" },
  resources: { vcpus: 1, memoryMb: 512 },
};

const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
});

const PVC_UID = "pvc-uid-created-by-this-boot";

/** Record creates and answer like the API server: the PVC comes back with a
 * server-assigned uid. `failPvc` makes the PVC create throw instead. */
function captureCreates(failPvc?: Error): KubeResource[] {
  const created: KubeResource[] = [];
  spies.push(
    spyOn(kubeClient, "createResource").mockImplementation(async (r) => {
      if (r.kind === "PersistentVolumeClaim") {
        if (failPvc) throw failPvc;
        created.push(r);
        return { ...r, metadata: { ...r.metadata, uid: PVC_UID } };
      }
      created.push(r);
      return r;
    }),
  );
  return created;
}

type Deletion = [string, string, KubeDeleteOptions | undefined];

function captureDeletes(): Deletion[] {
  const deleted: Deletion[] = [];
  spies.push(
    spyOn(kubeClient, "deleteResource").mockImplementation(
      async (kind, name, _namespace, options) => {
        deleted.push([kind, name, options]);
      },
    ),
  );
  return deleted;
}

function freshMarker(created: KubeResource[]): string | undefined {
  const pod = created.find((r) => r.kind === "Pod");
  if (!pod) throw new Error("no Pod was created");
  const env = (
    pod.spec as {
      containers: Array<{ env: Array<{ name: string; value: string }> }>;
    }
  ).containers[0]?.env;
  return env?.find((e) => e.name === VM.DATA_FRESH_ENV)?.value;
}

async function boot(input: Partial<BootInput>, agent = new AgentClient()) {
  return bootSandbox(ID, spec, { image: "img", ...input }, agent);
}

function failingAgent() {
  const agent = new AgentClient();
  spies.push(
    spyOn(agent, "waitForAgent").mockResolvedValue({
      ready: false,
      podIp: null,
    }),
  );
  return agent;
}

describe("bootSandbox fresh-volume marker", () => {
  test("blank PVC created in this boot: marker set", async () => {
    const created = captureCreates();
    await boot({});
    expect(created.some((r) => r.kind === "PersistentVolumeClaim")).toBe(true);
    expect(freshMarker(created)).toBe("1");
  });

  test("snapshot-cloned PVC (prebuild / pause snapshot): no marker", async () => {
    const created = captureCreates();
    await boot({ snapshotName: "snap-abc" });
    const pvc = created.find((r) => r.kind === "PersistentVolumeClaim");
    const pvcSpec = pvc?.spec as { dataSource?: unknown } | undefined;
    expect(pvcSpec?.dataSource).toBeDefined();
    expect(freshMarker(created)).toBeUndefined();
  });

  test("resumed (reused) PVC: no marker, no PVC create", async () => {
    const created = captureCreates();
    await boot({ reusePvc: true, preserveDisk: true });
    expect(created.some((r) => r.kind === "PersistentVolumeClaim")).toBe(false);
    expect(freshMarker(created)).toBeUndefined();
  });
});

describe("bootSandbox failed-resume rollback", () => {
  const pvcDeletion = (deleted: Deletion[]) =>
    deleted.find(
      ([kind, name]) =>
        kind === "PersistentVolumeClaim" && name === `sandbox-${ID}`,
    );
  const pvcDeleted = (deleted: Deletion[]) => Boolean(pvcDeletion(deleted));

  test("from-scratch resume (blank PVC) drops the PVC it created, by uid", async () => {
    captureCreates();
    const deleted = captureDeletes();
    await expect(boot({ preserveDisk: true }, failingAgent())).rejects.toThrow(
      "did not become ready",
    );
    expect(deleted.some(([kind]) => kind === "Pod")).toBe(true);
    // Deleted with a uid precondition, so the API server refuses to remove
    // any other object that happens to carry the same name.
    expect(pvcDeletion(deleted)?.[2]).toEqual({
      preconditions: { uid: PVC_UID },
    });
  });

  test("PVC create 409 → boot fails → existing PVC NOT deleted", async () => {
    // `resume` believed there was no PVC (reusePvc false) but one exists —
    // e.g. a running sandbox marked error at startup whose existence check
    // hit an API blip. That PVC holds the workspace: never touch it.
    const created = captureCreates(
      new KubeApiError(
        `persistentvolumeclaims "sandbox-${ID}" already exists`,
        409,
        "AlreadyExists",
      ),
    );
    const deleted = captureDeletes();
    await expect(boot({ preserveDisk: true })).rejects.toThrow(
      "already exists",
    );
    expect(pvcDeleted(deleted)).toBe(false);
    // Aborted before the batch: no pod ever carried the fresh-volume marker
    // against a disk this boot didn't create.
    expect(created.some((r) => r.kind === "Pod")).toBe(false);
  });

  test("PVC create without a returned uid: never deleted", async () => {
    // Can't prove it's ours (no uid to pin the delete to) → keep it.
    spies.push(
      spyOn(kubeClient, "createResource").mockImplementation(async (r) => r),
    );
    const deleted = captureDeletes();
    await expect(boot({ preserveDisk: true }, failingAgent())).rejects.toThrow(
      "did not become ready",
    );
    expect(pvcDeleted(deleted)).toBe(false);
  });

  test("reused PVC is kept (holds the paused workspace)", async () => {
    captureCreates();
    const deleted = captureDeletes();
    await expect(
      boot({ reusePvc: true, preserveDisk: true }, failingAgent()),
    ).rejects.toThrow("did not become ready");
    expect(deleted.some(([kind]) => kind === "Pod")).toBe(true);
    expect(pvcDeleted(deleted)).toBe(false);
  });

  test("snapshot-cloned resume PVC is kept (retry reuses the clone)", async () => {
    captureCreates();
    const deleted = captureDeletes();
    await expect(
      boot({ snapshotName: "snap-abc", preserveDisk: true }, failingAgent()),
    ).rejects.toThrow("did not become ready");
    expect(pvcDeleted(deleted)).toBe(false);
  });
});
