/**
 * `RuntimeService.refreshToolset` over the test doubles with a scripted
 * agent: the
 * base toolset is mounted, the steps run, and the capture only happens when
 * the fingerprint moved (or could not be told).
 */
import { describe, expect, test } from "bun:test";
import type { ToolsetRefreshRequest } from "@atelier/spec";
import { RuntimeService } from "./runtime.service.ts";
import { FakeAgentClient, fakeRuntimeDeps } from "./runtime.test-support.ts";
import * as stores from "./store.ts";

const BASE_REF = `toolsets/tb/org/o1/pi-web@sha256:${"a".repeat(64)}`;
const NEW_DIGEST = `sha256:${"b".repeat(64)}`;

const request: ToolsetRefreshRequest = {
  name: "tb/org/o1/pi-web",
  source: { image: "registry.test/base:1" },
  base: { ref: BASE_REF },
  steps: ["pi update --all"],
  paths: ["~/.local/bin", "~/.pi/agent"],
};

/** A runtime whose agent answers each fingerprint exec with the next value
 * of `fingerprints` and fails the steps listed in `failing`. */
function makeRuntime(fingerprints: string[], failing: string[] = []) {
  const agent = new FakeAgentClient();
  const calls = {
    steps: [] as string[],
    captures: 0,
    materialized: [] as string[][],
  };
  const answers = [...fingerprints];
  agent.exec = async (_id, command) => {
    if (command.includes("sha256sum")) {
      return { exitCode: 0, stdout: `${answers.shift() ?? ""}\n`, stderr: "" };
    }
    calls.steps.push(command);
    return failing.includes(command)
      ? { exitCode: 1, stdout: "", stderr: "npm ERR! boom" }
      : { exitCode: 0, stdout: "updated", stderr: "" };
  };
  agent.captureToolset = async () => {
    calls.captures++;
    return { digest: NEW_DIGEST };
  };
  agent.materializeToolsets = async (_id, references) => {
    calls.materialized.push(references);
  };
  const toolsets = new stores.InMemoryToolsetStore();
  const runtime = new RuntimeService({
    ...fakeRuntimeDeps(),
    agent,
    toolsets,
    sandboxes: new stores.InMemorySandboxStore(),
    snapshots: new stores.InMemorySnapshotStore(),
    sandboxToolsetRefs: new stores.InMemorySandboxToolsetRefStore(),
  });
  return { runtime, calls, toolsets };
}

const H1 = "1".repeat(64);
const H2 = "2".repeat(64);

describe("RuntimeService.refreshToolset", () => {
  test("unchanged paths: the steps run on the base, nothing is pushed", async () => {
    const { runtime, calls, toolsets } = makeRuntime([H1, H1]);
    const result = await runtime.refreshToolset(request);
    expect(result).toEqual({ changed: false });
    expect(calls.steps).toEqual(["pi update --all"]);
    expect(calls.captures).toBe(0);
    expect(calls.materialized).toHaveLength(1);
    expect(calls.materialized[0]?.[0]?.endsWith(BASE_REF)).toBe(true);
    expect(toolsets.list()).toHaveLength(0);
  });

  test("changed paths: captured and recorded as a private refreshed toolset", async () => {
    const { runtime, calls, toolsets } = makeRuntime([H1, H2]);
    const result = await runtime.refreshToolset(request);
    const ref = `toolsets/${request.name}@${NEW_DIGEST}`;
    expect(result).toEqual({ changed: true, ref });
    expect(calls.captures).toBe(1);
    const entry = runtime.getToolsetEntry(ref);
    expect(entry?.private).toBe(true);
    expect(entry?.provenance).toEqual({
      kind: "refreshed",
      base: BASE_REF,
      steps: ["pi update --all"],
    });
    expect(toolsets.list()).toHaveLength(1);
  });

  test("an unknown fingerprint never skips: it captures", async () => {
    const { runtime, calls } = makeRuntime(["", ""]);
    const result = await runtime.refreshToolset(request);
    expect(result.changed).toBe(true);
    expect(calls.captures).toBe(1);
  });

  test("a failing step fails the refresh before any capture", async () => {
    const { runtime, calls } = makeRuntime(
      [H1, H2],
      ["~/.local/bin/pi install npm:x"],
    );
    await expect(
      runtime.refreshToolset({
        ...request,
        steps: ["~/.local/bin/pi install npm:x", "pi update --all"],
      }),
    ).rejects.toThrow(/exit 1/);
    expect(calls.steps).toEqual(["~/.local/bin/pi install npm:x"]);
    expect(calls.captures).toBe(0);
  });

  test("refuses a refresh without steps or paths", async () => {
    const { runtime } = makeRuntime([]);
    await expect(
      runtime.refreshToolset({ ...request, steps: [] }),
    ).rejects.toThrow(/at least one step/);
    await expect(
      runtime.refreshToolset({ ...request, paths: [] }),
    ).rejects.toThrow(/paths/);
  });
});
