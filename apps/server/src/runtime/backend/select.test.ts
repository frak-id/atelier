/**
 * Sandbox-backend selection (proposal §3, §8). `kubernetes` and `docker` are
 * wired; the reserved `local` backend must fail fast with a clear message
 * rather than silently falling back.
 */
import { describe, expect, test } from "bun:test";

process.env.ATELIER_SERVER_MODE = "mock";

const { createSandboxBackend, KubernetesBackend, DockerBackend } = await import(
  "./index.ts"
);

describe("createSandboxBackend", () => {
  test("kubernetes is the implemented backend", () => {
    expect(createSandboxBackend("kubernetes")).toBeInstanceOf(
      KubernetesBackend,
    );
  });

  test("docker is implemented", () => {
    expect(createSandboxBackend("docker")).toBeInstanceOf(DockerBackend);
  });

  test("defaults to kubernetes (config default)", () => {
    expect(createSandboxBackend()).toBeInstanceOf(KubernetesBackend);
  });

  test("local is reserved and fails fast", () => {
    expect(() => createSandboxBackend("local")).toThrow(/not yet implemented/);
  });
});
