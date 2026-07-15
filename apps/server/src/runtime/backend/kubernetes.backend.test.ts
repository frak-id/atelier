/**
 * Volume-backend provider selection (proposal §5-6, §8). Only `csi` is
 * implemented; the host-FS ladder + OCI-tar materialization are the deferred,
 * infra-gated follow-up, so a non-csi provider must fail fast rather than
 * silently degrade.
 */
import { describe, expect, test } from "bun:test";

process.env.ATELIER_SERVER_MODE = "mock";

const { createVolumeBackend, CsiVolumeBackend } = await import(
  "./kubernetes.backend.ts"
);

describe("createVolumeBackend", () => {
  test("csi is the implemented provider", () => {
    expect(createVolumeBackend("csi")).toBeInstanceOf(CsiVolumeBackend);
  });

  test("defaults to csi (config default)", () => {
    expect(createVolumeBackend()).toBeInstanceOf(CsiVolumeBackend);
  });

  test.each([
    "btrfs",
    "reflink",
    "copy",
  ] as const)("%s is reserved and fails fast", (provider) => {
    expect(() => createVolumeBackend(provider)).toThrow(/not yet implemented/);
  });
});
