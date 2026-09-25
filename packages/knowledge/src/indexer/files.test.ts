import { afterEach, describe, expect, test } from "bun:test";
import { listRepoFiles, readRepoFile } from "./files.ts";
import { cleanupFixture, writeFixture } from "./test-helpers.ts";

let root: string | undefined;
afterEach(async () => {
  if (root) await cleanupFixture(root);
  root = undefined;
});

describe("listRepoFiles (no .git → walk fallback)", () => {
  test("skips default-ignored directories and sorts", async () => {
    root = await writeFixture({
      "src/a.ts": "export const a = 1;",
      "src/b.ts": "export const b = 2;",
      "node_modules/dep/index.js": "module.exports = {};",
      "dist/out.js": "// built",
      "README.md": "# hi",
    });
    const files = await listRepoFiles(root);
    expect(files).toEqual(["README.md", "src/a.ts", "src/b.ts"]);
  });
});

describe("listRepoFiles (.git present → git ls-files)", () => {
  test("lists cached and untracked-but-not-ignored files", async () => {
    root = await writeFixture({
      "src/a.ts": "export const a = 1;",
      ".gitignore": "ignored.txt\n",
      "ignored.txt": "nope",
      "untracked.md": "# untracked",
    });
    Bun.spawnSync(["git", "-C", root, "init", "--quiet"]);
    Bun.spawnSync(["git", "-C", root, "config", "user.email", "t@t.co"]);
    Bun.spawnSync(["git", "-C", root, "config", "user.name", "t"]);
    Bun.spawnSync(["git", "-C", root, "add", "src/a.ts", ".gitignore"]);
    Bun.spawnSync(["git", "-C", root, "commit", "-q", "-m", "init"]);

    const files = await listRepoFiles(root);
    expect(files).toContain("src/a.ts");
    expect(files).toContain(".gitignore");
    expect(files).toContain("untracked.md");
    expect(files).not.toContain("ignored.txt");
  });
});

describe("readRepoFile", () => {
  test("returns undefined for missing files and oversized files", async () => {
    root = await writeFixture({ "small.txt": "hi" });
    expect(await readRepoFile(root, "missing.txt")).toBeUndefined();
    expect(await readRepoFile(root, "small.txt", 1)).toBeUndefined();
    expect(await readRepoFile(root, "small.txt")).toBe("hi");
  });
});
