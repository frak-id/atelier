/**
 * Block-volume wiring for the workspace PVC (Option C,
 * docs/plans/toolset-inplace-update-fix-options.md §3). The PVC is attached as
 * a raw block device (virtio-blk under Kata) and the guest formats/mounts it —
 * so the pod must use `volumeDevices` (not `volumeMounts`) and the PVC must
 * declare `volumeMode: Block`.
 */

import { describe, expect, test } from "bun:test";
import { VM } from "@frak/atelier-shared/constants";

process.env.ATELIER_SERVER_MODE = "mock";

const { buildPvc, buildSandboxPod, buildSshPipe } = await import(
  "./kube.resources.ts"
);

describe("buildSandboxPod workspace volume", () => {
  const pod = buildSandboxPod({
    sandboxId: "abc123",
    image: "img",
    agentPassword: "pw",
    pvcName: "sandbox-abc123",
  });
  const container = (pod.spec as { containers: Array<Record<string, unknown>> })
    .containers[0] as Record<string, unknown>;

  test("attaches the PVC as a raw block device, not a filesystem mount", () => {
    const devices = container.volumeDevices as Array<Record<string, unknown>>;
    expect(devices).toEqual([
      { name: "workspace", devicePath: VM.DATA_DEVICE },
    ]);
    // The workspace must NOT appear as a filesystem volumeMount.
    const mounts = (container.volumeMounts ?? []) as Array<
      Record<string, unknown>
    >;
    expect(mounts.some((m) => m.name === "workspace")).toBe(false);
  });

  test("no volumeDevices when there is no PVC", () => {
    const noPvc = buildSandboxPod({
      sandboxId: "x",
      image: "i",
      agentPassword: "p",
    });
    const c = (noPvc.spec as { containers: Array<Record<string, unknown>> })
      .containers[0] as Record<string, unknown>;
    expect(c.volumeDevices).toBeUndefined();
  });
});

describe("buildSshPipe", () => {
  test("no knownHostsData: unpinned fallback (ignore_hostkey, no known_hosts_data)", () => {
    const pipe = buildSshPipe({
      sandboxId: "abc123",
      targetHost: "sandbox-abc123.ns.svc",
    });
    const to = (pipe.spec as { to: Record<string, unknown> }).to;
    expect(to.ignore_hostkey).toBe(true);
    expect(to.known_hosts_data).toBeUndefined();
    expect(to.host).toBe("sandbox-abc123.ns.svc:22");
  });

  test("knownHostsData set: pinned (ignore_hostkey false, known_hosts_data carried through)", () => {
    const pipe = buildSshPipe({
      sandboxId: "abc123",
      targetHost: "sandbox-abc123.ns.svc",
      knownHostsData: "c2FuZGJveC1hYmMxMjMubnMuc3ZjIHNzaC1lZDI1NTE5IEFBQUE=",
    });
    const to = (pipe.spec as { to: Record<string, unknown> }).to;
    expect(to.ignore_hostkey).toBe(false);
    expect(to.known_hosts_data).toBe(
      "c2FuZGJveC1hYmMxMjMubnMuc3ZjIHNzaC1lZDI1NTE5IEFBQUE=",
    );
  });
});

describe("buildPvc", () => {
  test("declares volumeMode: Block", () => {
    const pvc = buildPvc({ name: "sandbox-abc123", size: "20Gi" });
    expect((pvc.spec as Record<string, unknown>).volumeMode).toBe("Block");
  });

  test("carries a snapshot dataSource through unchanged (block restore)", () => {
    const pvc = buildPvc({
      name: "sandbox-abc123",
      size: "20Gi",
      snapshotName: "snap-1",
    });
    const spec = pvc.spec as Record<string, unknown>;
    expect(spec.volumeMode).toBe("Block");
    expect(spec.dataSource).toMatchObject({
      name: "snap-1",
      kind: "VolumeSnapshot",
    });
  });
});
