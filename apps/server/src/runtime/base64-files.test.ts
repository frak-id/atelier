import { describe, expect, test } from "bun:test";
import type { ExecResult, FileWrite } from "./agent/index.ts";
import { normalizeBase64, writeBase64Files } from "./base64-files.ts";

/** Records what reaches the agent; `exec` runs a fake decode result. */
function fakeAgent(exec: (command: string) => ExecResult = () => ok) {
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
      ) => {
        execs.push({ command, user: options.user });
        return exec(command);
      },
    },
  };
}
const ok: ExecResult = { exitCode: 0, stdout: "", stderr: "" };

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff]).toString("base64");

describe("normalizeBase64", () => {
  test("accepts whitespace, URL-safe alphabet and missing padding", () => {
    expect(normalizeBase64("iVBO\nRw==")).toBe("iVBORw==");
    expect(normalizeBase64("-_8")).toBe("+/8=");
    expect(normalizeBase64("")).toBe("");
  });

  test("rejects what isn't base64", () => {
    expect(normalizeBase64("not base64!")).toBeNull();
    expect(normalizeBase64("ab=c")).toBeNull();
    expect(normalizeBase64("abcde")).toBeNull();
  });
});

describe("writeBase64Files", () => {
  test("stages the base64 text root-only, then decodes it into place", async () => {
    const h = fakeAgent();
    const results = await writeBase64Files(h.agent, "sb1", [
      {
        path: "/home/dev/app/logo.png",
        content: PNG,
        mode: "644",
        owner: "dev",
      },
    ]);
    expect(results).toEqual([
      { path: "/home/dev/app/logo.png", success: true },
    ]);

    const staged = h.writes[0]?.[0];
    expect(staged?.path).toMatch(/^\/tmp\/\.atelier-upload-[a-z0-9]+\.b64$/);
    expect(staged).toMatchObject({ content: PNG, mode: "600", owner: "root" });

    const decode = h.execs[0];
    expect(decode?.user).toBe("root");
    expect(decode?.command).toContain(`src='${staged?.path}'`);
    expect(decode?.command).toContain("dst='/home/dev/app/logo.png'");
    expect(decode?.command).toContain('base64 -d "$src" > "$tmp"');
    expect(decode?.command).toContain('chmod 644 "$tmp"');
    expect(decode?.command).toContain('chown 1000:1000 "$tmp"');
  });

  test("quotes a path with a single quote", async () => {
    const h = fakeAgent();
    await writeBase64Files(h.agent, "sb1", [
      { path: "/home/dev/it's here.png", content: PNG },
    ]);
    expect(h.execs[0]?.command).toContain("dst='/home/dev/it'\\''s here.png'");
  });

  test("reports bad input per file without touching the sandbox for it", async () => {
    const h = fakeAgent();
    const results = await writeBase64Files(h.agent, "sb1", [
      { path: "relative.png", content: PNG },
      { path: "/a.png", content: "%%%" },
      { path: "/b.png", content: PNG, mode: "rwx" },
      { path: "/c.png", content: PNG, owner: "nobody" },
      { path: "/d.png", content: PNG },
    ]);
    expect(results.map((r) => r.error ?? "ok")).toEqual([
      "path must be absolute",
      "content is not valid base64",
      "bad mode: rwx",
      "unknown owner: nobody",
      "ok",
    ]);
    expect(h.writes[0]).toHaveLength(1);
    expect(h.execs).toHaveLength(1);
  });

  test("a failing decode is that file's error", async () => {
    const h = fakeAgent(() => ({
      exitCode: 1,
      stdout: "",
      stderr: "mkdir: cannot create directory '/proc/x': No such file\n",
    }));
    const [result] = await writeBase64Files(h.agent, "sb1", [
      { path: "/proc/x/y.png", content: PNG },
    ]);
    expect(result).toEqual({
      path: "/proc/x/y.png",
      success: false,
      error: "mkdir: cannot create directory '/proc/x': No such file",
    });
  });
});
