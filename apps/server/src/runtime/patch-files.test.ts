import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult, FileWrite } from "./agent/index.ts";
import { MKDIRS_FN } from "./file-owner.ts";
import { ownedParentsScript, writePatchFiles } from "./patch-files.ts";

function fakeAgent() {
  const writes: FileWrite[][] = [];
  const execs: { command: string; user?: string }[] = [];
  return {
    writes,
    execs,
    agent: {
      writeFiles: async (_id: string, files: FileWrite[]) => {
        writes.push(files);
        return {
          results: files.map((f) => ({ path: f.path, success: true })),
        };
      },
      exec: async (
        _id: string,
        command: string,
        options: { user?: "dev" | "root" } = {},
      ): Promise<ExecResult> => {
        execs.push({ command, user: options.user });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  };
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");

describe("writePatchFiles", () => {
  test("files are dev's unless the entry says otherwise", async () => {
    const h = fakeAgent();
    await writePatchFiles(h.agent, "sb1", [
      { path: "/home/dev/a.txt", content: "a" },
      { path: "/etc/b.conf", content: "b", owner: "root" },
      { path: "/home/dev/c.png", content: PNG, encoding: "base64" },
    ]);
    const text = h.writes.find((w) => !w[0]?.path.startsWith("/tmp/"));
    expect(text?.map((f) => [f.path, f.owner])).toEqual([
      ["/home/dev/a.txt", "dev"],
      ["/etc/b.conf", "root"],
    ]);
    const decode = h.execs.find((e) => e.command.includes("base64 -d"));
    expect(decode?.command).toContain('chown 1000:1000 "$tmp"');
    expect(decode?.command).toContain('mkdirs "$(dirname "$dst")" 1000:1000');
  });

  test("creates a dev file's missing parent directories as dev first", async () => {
    const h = fakeAgent();
    await writePatchFiles(h.agent, "sb1", [
      { path: "/home/dev/uploads/new/a.txt", content: "a" },
    ]);
    expect(h.execs).toHaveLength(1);
    expect(h.execs[0]?.user).toBe("root");
    expect(h.execs[0]?.command).toContain(
      "mkdirs '/home/dev/uploads/new' 1000:1000 || status=1",
    );
    expect(h.writes).toHaveLength(1);
  });

  test("keeps request order across text and base64 entries", async () => {
    const h = fakeAgent();
    const { results } = await writePatchFiles(h.agent, "sb1", [
      { path: "/home/dev/1.png", content: PNG, encoding: "base64" },
      { path: "/home/dev/2.txt", content: "x" },
      { path: "/home/dev/3.png", content: "%%%", encoding: "base64" },
    ]);
    expect(results.map((r) => [r.path, r.success])).toEqual([
      ["/home/dev/1.png", true],
      ["/home/dev/2.txt", true],
      ["/home/dev/3.png", false],
    ]);
  });
});

describe("ownedParentsScript", () => {
  test("nothing to create for root files or directories that always exist", () => {
    expect(
      ownedParentsScript([
        { path: "/home/dev/a", content: "", owner: "dev" },
        { path: "/tmp/b", content: "", owner: "dev" },
        { path: "/etc/x/c", content: "", owner: "root" },
        { path: "/opt/d", content: "", owner: "nobody" },
      ]),
    ).toBeUndefined();
  });

  test("one call per directory", () => {
    const script = ownedParentsScript([
      { path: "/home/dev/u/a", content: "", owner: "dev" },
      { path: "/home/dev/u/b", content: "", owner: "dev" },
      { path: "/home/dev/it's/c", content: "", owner: "dev" },
    ]);
    expect(script?.match(/^mkdirs /gm)).toHaveLength(2);
    expect(script).toContain("mkdirs '/home/dev/it'\\''s' 1000:1000");
  });
});

describe("mkdirs (the shell function)", () => {
  test("gives only the directories it created to the owner", async () => {
    const root = mkdtempSync(join(tmpdir(), "mkdirs-"));
    mkdirSync(join(root, "existing"));
    // A `chown` that records its arguments instead of changing anything.
    const bin = join(root, "bin");
    mkdirSync(bin);
    const calls = join(root, "calls");
    writeFileSync(join(bin, "chown"), `#!/bin/sh\necho "$@" >> '${calls}'\n`, {
      mode: 0o755,
    });
    writeFileSync(calls, "");
    const script = [
      MKDIRS_FN,
      `mkdirs '${root}/existing/a/b' 1000:1000`,
      `mkdirs '${root}/existing' 1000:1000`,
    ].join("\n");
    const run = Bun.spawnSync(["bash", "-c", script], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    expect(run.exitCode).toBe(0);
    expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual([
      `-R 1000:1000 ${root}/existing/a`,
    ]);
  });
});
