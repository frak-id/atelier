import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import { CreateSandboxRequestSchema } from "./create-request.ts";
import { SandboxSpecSchema } from "./sandbox-spec.ts";

const source = { image: "dev-base" };

describe("CreateSandboxRequestSchema.resources", () => {
  test("is optional: a bare source is a valid request", () => {
    expect(Value.Check(CreateSandboxRequestSchema, { source })).toBe(true);
  });

  test("each field is optional on its own", () => {
    for (const resources of [
      {},
      { vcpus: 4 },
      { memoryMb: 2048 },
      { diskGb: 20 },
    ]) {
      expect(
        Value.Check(CreateSandboxRequestSchema, { source, resources }),
      ).toBe(true);
    }
  });

  test("the bounds still apply to what is given", () => {
    for (const resources of [{ vcpus: 0 }, { memoryMb: 128 }, { diskGb: 0 }]) {
      expect(
        Value.Check(CreateSandboxRequestSchema, { source, resources }),
      ).toBe(false);
    }
  });

  test("unknown resource keys and top-level keys are still rejected", () => {
    expect(
      Value.Check(CreateSandboxRequestSchema, {
        source,
        resources: { gpus: 1 },
      }),
    ).toBe(false);
    expect(
      Value.Check(CreateSandboxRequestSchema, { source, bogus: true }),
    ).toBe(false);
  });

  test("the runtime's SandboxSpec stays strict: resources is required there", () => {
    expect(Value.Check(SandboxSpecSchema, { source })).toBe(false);
    expect(
      Value.Check(SandboxSpecSchema, {
        source,
        resources: { vcpus: 2, memoryMb: 4096 },
      }),
    ).toBe(true);
  });
});
