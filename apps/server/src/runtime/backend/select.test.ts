/**
 * Sandbox-backend selection (proposal §3, §8). Only `kubernetes` is wired; the
 * docker/local backends are in-progress, so selecting them must fail fast with
 * a clear message rather than silently falling back.
 */
import { describe, expect, test } from "bun:test";

process.env.ATELIER_SERVER_MODE = "mock";

const { createSandboxBackend, KubernetesBackend } = await import("./index.ts");

describe("createSandboxBackend", () => {
  test("kubernetes is the implemented backend", () => {
    expect(createSandboxBackend("kubernetes")).toBeInstanceOf(
      KubernetesBackend,
    );
  });

  test("defaults to kubernetes (config default)", () => {
    expect(createSandboxBackend()).toBeInstanceOf(KubernetesBackend);
  });

  test.each([
    "docker",
    "local",
  ] as const)("%s is not yet implemented and fails fast", (backend) => {
    expect(() => createSandboxBackend(backend)).toThrow(/not yet implemented/);
  });
});
