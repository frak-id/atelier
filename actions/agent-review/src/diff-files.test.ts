import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A repository in a temporary directory, without the machine's git config
// (signing, hooks): a base that moves on (main), and a PR reviewed at
// `earlier`, then rebased onto main's new commit and pushed again (`head`).
const root = mkdtempSync(join(tmpdir(), "diff-files-"));
const repo = join(root, "repo");
const script = join(import.meta.dir, "diff-files.sh");
const env = {
  PATH: process.env.PATH ?? "",
  HOME: root,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

function run(command: string[]): string {
  const result = Bun.spawnSync(command, { cwd: repo, env });
  if (result.exitCode !== 0)
    throw new Error(`${command.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}
const git = (...args: string[]) => run(["git", ...args]);
const write = (path: string, text: string | Uint8Array) => {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), text);
};
const lines = (count: number, changed: Record<number, string> = {}) =>
  Array.from(
    { length: count },
    (_, i) => changed[i + 1] ?? `line ${i + 1}`,
  ).join("\n");
const commit = (message: string) => {
  git("add", "-A");
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
};

/** The PR's changes: a modified file, a renamed one (to a name with spaces and
 * glob characters), a deleted one, new text, a new binary file and two files
 * turned into a symlink, one in the middle of the diff and one (`zz-link.md`)
 * at its end (git writes each as two sections, a deletion and a creation). */
function prChanges() {
  write("src/keep.ts", lines(10, { 2: "line 2 changed" }));
  unlinkSync(join(repo, "src/old name.ts"));
  write("src/new [1]*.ts", lines(10, { 5: "line 5 changed" }));
  unlinkSync(join(repo, "gone.ts"));
  write("docs/a b.md", "# Title\n\nText.\n");
  write("logo.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 0]));
  unlinkSync(join(repo, "link.md"));
  symlinkSync("target.md", join(repo, "link.md"));
  unlinkSync(join(repo, "zz-link.md"));
  symlinkSync("target.md", join(repo, "zz-link.md"));
}

let mergeBase = "";
let earlier = "";
let head = "";
const read = (out: string, path: string) =>
  readFileSync(join(root, out, path), "utf8");
const diffFiles = (out: string, ...since: string[]) =>
  run(["bash", script, mergeBase, head, join(root, out), ...since]);

beforeAll(() => {
  mkdirSync(repo);
  git("init", "-q", "-b", "main");
  write("src/keep.ts", lines(10));
  write("src/old name.ts", lines(10));
  write("gone.ts", lines(3));
  write("link.md", lines(4));
  write("zz-link.md", lines(2));
  write("target.md", "# Target\n");
  write("untouched.ts", lines(3));
  const base = commit("base");
  write("untouched.ts", lines(3, { 1: "changed on main" }));
  mergeBase = commit("main moves on");

  git("checkout", "-q", "-b", "first-push", base);
  prChanges();
  earlier = commit("the PR");

  git("checkout", "-q", "-b", "rebased", mergeBase);
  prChanges();
  write("src/keep.ts", lines(10, { 2: "line 2 changed", 8: "line 8 changed" }));
  write("late.ts", "export const late = 1;\n");
  head = commit("the PR, rebased, and a fix");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("the PR's diff, as files", () => {
  test("lists each file once, with its status, its counts and, renamed, the path it had", () => {
    expect(diffFiles("out")).toBe("diff: 8 files");
    expect(read("out", "files.tsv").trimEnd().split("\n").sort()).toEqual([
      "A\t+0 -0\tlogo.png",
      "A\t+1 -0\tlate.ts",
      "A\t+3 -0\tdocs/a b.md",
      "D\t+0 -3\tgone.ts",
      "M\t+2 -2\tsrc/keep.ts",
      "R\t+1 -1\tsrc/new [1]*.ts\t(was src/old name.ts)",
      "T\t+1 -2\tzz-link.md",
      "T\t+1 -4\tlink.md",
    ]);
    expect(existsSync(join(root, "out", "delta"))).toBe(false);
  });

  test("writes each file's own diff, under its path (its directories as `.d`)", () => {
    diffFiles("out");
    const keep = read("out", "diff/src.d/keep.ts.patch");
    expect(keep).toStartWith("diff --git a/src/keep.ts b/src/keep.ts\n");
    expect(keep).toContain("+line 2 changed\n");
    expect(keep).toContain("+line 8 changed");
    expect(keep).not.toContain("late");
    expect(read("out", "diff/src.d/new [1]*.ts.patch")).toContain(
      "rename from src/old name.ts\n",
    );
    expect(read("out", "diff/gone.ts.patch")).toContain("deleted file mode");
    expect(read("out", "diff/logo.png.patch")).toContain("Binary files");
    expect(existsSync(join(root, "out", "diff/untouched.ts.patch"))).toBe(
      false,
    );
  });

  test("joins the two sections of a file turned into a symlink, and keeps the files after it aligned", () => {
    diffFiles("out");
    const link = read("out", "diff/link.md.patch");
    expect(link.match(/^diff --git /gm)).toHaveLength(2);
    expect(link).toContain("deleted file mode 100644\n");
    expect(link).toContain("new file mode 120000\n");
    expect(link).toContain("-line 4\n");
    expect(link).toContain("+target.md\n");
    expect(link).not.toContain("changed");
    // `src/` files sort after `link.md`: their patches are their own.
    expect(read("out", "diff/src.d/keep.ts.patch")).toStartWith(
      "diff --git a/src/keep.ts b/src/keep.ts\n",
    );
    expect(read("out", "diff/src.d/new [1]*.ts.patch")).toContain(
      "rename from src/old name.ts\n",
    );
  });

  test("joins the two sections of a file turned into a symlink that is the last of the diff, with the counts aligned", () => {
    diffFiles("out");
    const link = read("out", "diff/zz-link.md.patch");
    expect(link.match(/^diff --git /gm)).toHaveLength(2);
    expect(link).toStartWith("diff --git a/zz-link.md b/zz-link.md\n");
    expect(link).toContain("deleted file mode 100644\n");
    expect(link).toContain("new file mode 120000\n");
    expect(link).toContain("-line 2\n");
    expect(link).toContain("+target.md");
    // the file before it keeps its own two sections, and the last file's counts
    // are its own
    expect(read("out", "diff/link.md.patch")).not.toContain("zz-link");
    expect(read("out", "files.tsv")).toEndWith("T\t+1 -2\tzz-link.md\n");
  });

  test("after an earlier review, adds what changed since on the PR's files only, not what the rebase brought", () => {
    expect(diffFiles("since", earlier)).toBe("diff: 8 files; delta: 2 files");
    expect(
      read("since", "delta-files.tsv").trimEnd().split("\n").sort(),
    ).toEqual(["A\t+1 -0\tlate.ts", "M\t+1 -1\tsrc/keep.ts"]);
    const keep = read("since", "delta/src.d/keep.ts.patch");
    expect(keep).toContain("+line 8 changed");
    expect(keep).not.toContain("+line 2 changed");
    expect(existsSync(join(root, "since", "delta/untouched.ts.patch"))).toBe(
      false,
    );
  });

  test("a file and a directory that want the same patch name don't collide", () => {
    // `x` and `x.patch/y.md` (a file named like the other's patch), and a file
    // replaced by a directory.
    git("checkout", "-q", "-b", "collisions", mergeBase);
    write("x", "plain\n");
    write("x.patch/y.md", "under a directory named like x's patch\n");
    unlinkSync(join(repo, "gone.ts"));
    write("gone.ts/inner.ts", "export const inner = 1;\n");
    const collisions = commit("names that meet");
    git("checkout", "-q", "rebased");

    expect(
      run(["bash", script, mergeBase, collisions, join(root, "collide")]),
    ).toBe("diff: 4 files");
    expect(read("collide", "files.tsv").trimEnd().split("\n").sort()).toEqual([
      "A\t+1 -0\tgone.ts/inner.ts",
      "A\t+1 -0\tx",
      "A\t+1 -0\tx.patch/y.md",
      "D\t+0 -3\tgone.ts",
    ]);
    expect(read("collide", "diff/x.patch")).toContain("+plain\n");
    expect(read("collide", "diff/x.patch.d/y.md.patch")).toContain(
      "+under a directory named like x's patch\n",
    );
    expect(read("collide", "diff/gone.ts.patch")).toContain(
      "deleted file mode",
    );
    expect(read("collide", "diff/gone.ts.d/inner.ts.patch")).toContain(
      "+export const inner = 1;\n",
    );
  });

  test("escapes a backslash, a tab and a newline in a path, so no name forges a row or shifts the columns", () => {
    // A name that would add a forged row, with its own status and counts, if
    // written raw.
    const forged = "tab\there\nM\t+999 -999\tforged.ts";
    git("checkout", "-q", "-b", "odd-names", mergeBase);
    write(forged, "one\n");
    write("back\\slash/dir\ttab/f.ts", "two\n");
    unlinkSync(join(repo, "gone.ts"));
    write("odd\tnew\nname.ts", "fresh 1\nfresh 2\nfresh 3\n");
    const odd = commit("names with a tab, a newline and a backslash");
    git("checkout", "-q", "rebased");

    expect(run(["bash", script, mergeBase, odd, join(root, "odd")])).toBe(
      "diff: 4 files",
    );
    const rows = read("odd", "files.tsv").trimEnd().split("\n");
    expect(rows.sort()).toEqual([
      "A\t+1 -0\tback\\\\slash/dir\\ttab/f.ts",
      "A\t+1 -0\ttab\\there\\nM\\t+999 -999\\tforged.ts",
      "A\t+3 -0\todd\\tnew\\nname.ts",
      "D\t+0 -3\tgone.ts",
    ]);
    for (const row of rows) expect(row.split("\t")).toHaveLength(3);
    // The patches are under the escaped names, as files.tsv lists them.
    expect(
      read("odd", "diff/back\\\\slash.d/dir\\ttab.d/f.ts.patch"),
    ).toContain("+two\n");
    expect(
      read("odd", "diff/tab\\there\\nM\\t+999 -999\\tforged.ts.patch"),
    ).toContain("+one\n");
    expect(read("odd", "diff/odd\\tnew\\nname.ts.patch")).toContain(
      "+fresh 1\n",
    );
  });

  test("a rename from and to such names escapes both, the `was` column too", () => {
    git("checkout", "-q", "-b", "odd-rename", mergeBase);
    write("odd\tfrom.ts", lines(10));
    const before = commit("an odd name");
    git("mv", "odd\tfrom.ts", "odd\nto\\.ts");
    const renamed = commit("renamed");
    git("checkout", "-q", "rebased");

    expect(
      run(["bash", script, before, renamed, join(root, "odd-rename")]),
    ).toBe("diff: 1 files");
    expect(read("odd-rename", "files.tsv")).toBe(
      "R\t+0 -0\todd\\nto\\\\.ts\t(was odd\\tfrom.ts)\n",
    );
    expect(read("odd-rename", "diff/odd\\nto\\\\.ts.patch")).toContain(
      'rename from "odd\\tfrom.ts"\n',
    );
  });

  test("when the PR changes no file, still writes an empty delta for an earlier review's head", () => {
    expect(
      run(["bash", script, mergeBase, mergeBase, join(root, "empty"), earlier]),
    ).toBe("diff: 0 files; delta: 0 files");
    expect(read("empty", "files.tsv")).toBe("");
    expect(read("empty", "delta-files.tsv")).toBe("");
    expect(existsSync(join(root, "empty", "delta"))).toBe(true);
    expect(readdirSync(join(root, "empty", "delta"))).toEqual([]);
  });

  test("an earlier review of the same head adds no delta", () => {
    expect(diffFiles("same", head)).toBe("diff: 8 files");
  });
});
