import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxSpec } from "@atelier/spec";
import { provisionAgent } from "./boot-agent.ts";
import { RuntimeService } from "./runtime.service.ts";
import {
  FakeAgentClient,
  FakeBackend,
  fakeRuntimeDeps,
} from "./runtime.test-support.ts";
import * as stores from "./store.ts";
import { useTestDatabase } from "./test-database.ts";
import { unhideCommand } from "./unhide-toolset-dirs.ts";

const spec: SandboxSpec = {
  source: { image: "registry.test/base:1" },
  resources: { vcpus: 1, memoryMb: 512 },
};
const TOOLSET_REF = `toolsets/alice-pi-stack@sha256:${"a".repeat(64)}`;

describe("unhideCommand", () => {
  test("nothing to run without a home path", () => {
    expect(unhideCommand([])).toBeUndefined();
    expect(unhideCommand(["/etc", "~/../x", "~"])).toBeUndefined();
  });

  test("targets the sandbox upper, once per home-relative path", () => {
    const command = unhideCommand([
      "~/.local/bin",
      "$HOME/.local/bin/",
      "/home/dev/.pi/agent",
      "/etc",
    ]);
    expect(command).toStartWith("'python3' '-c' ");
    expect(command).toEndWith(
      "'/data/upper' '/home/dev' 'trusted.overlay.opaque' " +
        "'.local/bin' '.pi/agent'",
    );
  });
});

/* The script itself, against a scratch tree and `user.` xattrs (trusted.*
 * needs root). Linux only: macOS python has no os.getxattr. */
const XATTR = "user.overlay.opaque";

function python(code: string, ...args: string[]) {
  return Bun.spawnSync(["python3", "-c", code, ...args]);
}

function setOpaque(path: string): void {
  const res = python(
    "import os, sys; os.setxattr(sys.argv[1], sys.argv[2], b'y')",
    path,
    XATTR,
  );
  if (res.exitCode !== 0) throw new Error(res.stderr.toString());
}

function isOpaque(path: string): boolean {
  return (
    python("import os, sys; os.getxattr(sys.argv[1], sys.argv[2])", path, XATTR)
      .exitCode === 0
  );
}

const userXattrs = (() => {
  if (process.platform !== "linux") return false;
  const dir = mkdtempSync(join(tmpdir(), "unhide-probe-"));
  try {
    setOpaque(dir);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

describe.skipIf(!userXattrs)("the unhide script", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "unhide-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function run(home: string, paths: string[]) {
    const command = unhideCommand(paths, {
      upper: join(root, "upper"),
      home,
      xattr: XATTR,
    });
    if (!command) throw new Error("no command");
    const res = Bun.spawnSync(["bash", "-c", command]);
    expect(res.stderr.toString()).toBe("");
    expect(res.exitCode).toBe(0);
    return res.stdout.toString().split("\n").filter(Boolean);
  }

  function opaqueDir(rel: string): string {
    const path = join(root, rel);
    mkdirSync(path, { recursive: true });
    setOpaque(path);
    return path;
  }

  test("clears the declared paths and their parents, nothing below", () => {
    const local = opaqueDir("upper/.local");
    const bin = opaqueDir("upper/.local/bin");
    const pkg = opaqueDir("upper/.local/lib/node_modules/pkg");
    const config = opaqueDir("upper/.config");
    mkdirSync(join(root, "home"));

    const cleared = run(join(root, "home"), [
      "~/.local/bin",
      "~/.local/lib",
      "~/.missing/dir",
    ]);

    expect(cleared.sort()).toEqual([local, bin].sort());
    expect(isOpaque(local)).toBe(false);
    expect(isOpaque(bin)).toBe(false);
    // Inside a declared path: an in-place update's directory stays opaque.
    expect(isOpaque(pkg)).toBe(true);
    // Not provided by any toolset.
    expect(isOpaque(config)).toBe(true);
  });

  test("never follows a symlink out of the upper", () => {
    const outside = opaqueDir("outside/agent");
    mkdirSync(join(root, "upper"));
    symlinkSync(join(root, "outside"), join(root, "upper/.pi"));
    mkdirSync(join(root, "home"));

    expect(run(join(root, "home"), ["~/.pi/agent"])).toEqual([]);
    expect(isOpaque(outside)).toBe(true);
  });

  test("leaves the upper alone while the home is mounted", () => {
    const local = opaqueDir("upper/.local");
    expect(run("/", ["~/.local/bin"])).toEqual([]);
    expect(isOpaque(local)).toBe(true);
  });
});

describe("provisionAgent", () => {
  function recordingAgent() {
    const agent = new FakeAgentClient();
    const calls: string[] = [];
    agent.exec = async (
      _id: string,
      command: string,
      options?: { user?: string },
    ) => {
      calls.push(`exec:${options?.user}:${command.includes("'.local/bin'")}`);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    agent.materializeToolsets = async () => {
      calls.push("materialize");
    };
    return { agent, calls };
  }

  test("clears the opaque flags as root before materializing", async () => {
    const { agent, calls } = recordingAgent();
    await provisionAgent(
      "sb1",
      spec,
      { toolsets: ["registry/x"], toolsetPaths: ["~/.local/bin"] },
      agent,
    );
    expect(calls).toEqual(["exec:root:true", "materialize"]);
  });

  test("runs nothing without toolset paths", async () => {
    const { agent, calls } = recordingAgent();
    await provisionAgent("sb1", spec, { toolsets: [] }, agent);
    expect(calls).toEqual(["materialize"]);
  });

  test("a failed clear does not fail the boot", async () => {
    const { agent, calls } = recordingAgent();
    agent.exec = async () => {
      throw new Error("agent unavailable");
    };
    await provisionAgent(
      "sb1",
      spec,
      { toolsetPaths: ["~/.local/bin"] },
      agent,
    );
    expect(calls).toEqual(["materialize"]);
  });
});

describe("RuntimeService toolset paths", () => {
  beforeEach(() => useTestDatabase());

  class RecordingBackend extends FakeBackend {
    paths: Array<string[] | undefined> = [];
    override async boot(
      id: string,
      bootSpec: SandboxSpec,
      input: Parameters<FakeBackend["boot"]>[2],
      agent: Parameters<FakeBackend["boot"]>[3],
    ) {
      this.paths.push(input.toolsetPaths);
      return super.boot(id, bootSpec, input, agent);
    }
  }

  test("create and resume hand the boot the toolsets' paths", async () => {
    const backend = new RecordingBackend();
    const toolsets = new stores.DrizzleToolsetStore();
    toolsets.put({
      hash: "h1",
      name: "alice-pi-stack",
      ref: TOOLSET_REF,
      paths: ["~/.local/bin", "~/.pi/agent"],
      provenance: { kind: "built", build: [] },
      private: false,
      createdAt: new Date().toISOString(),
    });
    const runtime = new RuntimeService({
      ...fakeRuntimeDeps(),
      backend,
      sandboxes: new stores.DrizzleSandboxStore(),
      snapshots: new stores.DrizzleSnapshotStore(),
      toolsets,
      sandboxToolsetRefs: new stores.DrizzleSandboxToolsetRefStore(),
    });

    await runtime.create(
      { ...spec, toolsets: [{ ref: TOOLSET_REF }] },
      { id: "sb1" },
    );
    await runtime.pause("sb1");
    await runtime.resume("sb1");
    await runtime.create(spec, { id: "sb2" });

    const paths = ["~/.local/bin", "~/.pi/agent"];
    expect(backend.paths).toEqual([paths, paths, []]);
  });
});
