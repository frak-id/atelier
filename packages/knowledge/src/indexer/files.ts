/**
 * File discovery for the indexer: `.git`-aware listing (respects
 * `.gitignore`/`.git/info/exclude` through `git ls-files`) with a plain
 * walk fallback for checkouts without git metadata, plus the shared caps
 * every other indexer module reads through.
 */

import { type Dirent, existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, posix } from "node:path";

/** Hard cap on files listed; extraction stays bounded on huge monorepos. */
export const MAX_FILES = 50_000;

/** Files larger than this are listed but never read for parsing. */
export const MAX_PARSE_BYTES = 512 * 1024;

/** Directory names skipped by the walk fallback, at any depth. */
const DEFAULT_IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "target",
  ".next",
  "coverage",
  "vendor",
  ".turbo",
]);

/**
 * Lists every tracked/untracked-but-not-ignored file in `root`, relative to
 * it with `/` separators, sorted for deterministic output. Uses `git
 * ls-files` when `root/.git` exists (so `.gitignore` is honoured exactly as
 * git sees it); otherwise walks the tree skipping {@link DEFAULT_IGNORE_DIRS}.
 */
export async function listRepoFiles(root: string): Promise<string[]> {
  const files = existsSync(join(root, ".git"))
    ? await listFilesViaGit(root)
    : await walkFiles(root);
  files.sort();
  return files.slice(0, MAX_FILES);
}

async function listFilesViaGit(root: string): Promise<string[]> {
  const proc = Bun.spawn(
    [
      "git",
      "-C",
      root,
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [out, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`git ls-files failed in ${root}: ${err.trim()}`);
  }
  const seen = new Set<string>();
  for (const entry of out.split("\0")) {
    if (entry) seen.add(entry);
  }
  return [...seen];
}

async function walkFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (results.length >= MAX_FILES) return;
    let entries: Dirent<string>[];
    try {
      entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= MAX_FILES) return;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (DEFAULT_IGNORE_DIRS.has(entry.name)) continue;
        await walk(abs);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        const rel = abs.slice(root.length).replaceAll("\\", "/");
        results.push(rel.startsWith("/") ? rel.slice(1) : rel);
      }
    }
  }
  await walk(root);
  return results;
}

/** Reads `root/relPath` as UTF-8, or `undefined` if missing/too large. */
export async function readRepoFile(
  root: string,
  relPath: string,
  maxBytes = MAX_PARSE_BYTES,
): Promise<string | undefined> {
  const abs = join(root, relPath);
  try {
    const info = await stat(abs);
    if (!info.isFile() || info.size > maxBytes) return undefined;
    return await Bun.file(abs).text();
  } catch {
    return undefined;
  }
}

/** Posix-join within a repo-relative path space (always `/`-separated). */
export const rpath = posix;
