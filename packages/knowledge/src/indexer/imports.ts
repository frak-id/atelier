/**
 * Static import scanning: JS/TS `import`/`export … from`/dynamic
 * `import()`/`require()` specifiers, turned into package-level `imports`
 * facts (and, with `includeFiles`, `file` entities plus `contains`/
 * `imports` facts). Regex-based on purpose — the "agentic grep beats a
 * real parser" tradeoff this package's prior-art doc makes for a derived,
 * best-effort index.
 */
import type { EntityInput, FactInput, Readers } from "../types.ts";
import { readRepoFile, rpath } from "./files.ts";
import type { PackageInfo } from "./model.ts";
import { findOwner, sortOwners } from "./model.ts";

const JS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const FILE_ENTITY_EXTENSIONS = new Set([...JS_EXTENSIONS, ".rs", ".py", ".go"]);

/**
 * Matches static `import ... from "x"`, `export ... from "x"`, bare
 * `import "x"`, dynamic `import("x")` and `require("x")`. The `[^;]*?`
 * gaps stop at the statement's own semicolon so an unrelated later
 * `from`/`require` on the same line can't be swallowed.
 */
const SPEC_RE =
  /\bimport\s+[^;]*?\bfrom\s+["']([^"']+)["']|\bexport\s+[^;]*?\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\bimport\s+["']([^"']+)["']|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

/** Strips `//` and block comments so commented-out imports are ignored. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function extractSpecifiers(source: string): string[] {
  const clean = stripComments(source);
  const specs: string[] = [];
  for (const m of clean.matchAll(SPEC_RE)) {
    const spec = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5];
    if (spec) specs.push(spec);
  }
  return specs;
}

/** The package name a bare specifier belongs to (`@scope/name`-aware). */
function packageNameOf(specifier: string): string | undefined {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return undefined;
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) {
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : undefined;
  }
  return parts[0];
}

const RELATIVE_RESOLVE_SUFFIXES = [
  "",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  "/index.ts",
  "/index.tsx",
  "/index.js",
  "/index.jsx",
  "/index.mjs",
];

function resolveRelativeImport(
  fromFile: string,
  specifier: string,
  fileSet: Set<string>,
): string | undefined {
  const base = rpath.normalize(rpath.join(rpath.dirname(fromFile), specifier));
  for (const suffix of RELATIVE_RESOLVE_SUFFIXES) {
    const candidate = suffix === "" ? base : base + suffix;
    if (fileSet.has(candidate)) return candidate;
  }
  return undefined;
}

export interface ImportScanOpts {
  repo: string;
  files: string[];
  npmPackages: PackageInfo[];
  crates: { entityId: string; dir: string }[];
  readers: Readers;
  includeFiles: boolean;
}

export interface ImportScanResult {
  entities: EntityInput[];
  facts: FactInput[];
  warnings: string[];
}

export async function scanImports(
  root: string,
  opts: ImportScanOpts,
): Promise<ImportScanResult> {
  const entities: EntityInput[] = [];
  const facts: FactInput[] = [];
  const warnings: string[] = [];
  const fileSet = new Set(opts.files);
  const { readers } = opts;

  const npmOwners = sortOwners(
    opts.npmPackages.map((p) => ({ dir: p.dir, entityId: p.entityId })),
  );
  const allOwners = sortOwners([
    ...opts.npmPackages.map((p) => ({ dir: p.dir, entityId: p.entityId })),
    ...opts.crates.map((c) => ({ dir: c.dir, entityId: c.entityId })),
  ]);
  const nameToPackage = new Map(opts.npmPackages.map((p) => [p.name, p]));

  // Distinct importing files per (fromPackage, toPackage) pair.
  const packageImportFiles = new Map<string, Map<string, Set<string>>>();

  for (const file of opts.files) {
    const ext = rpath.extname(file);
    if (!FILE_ENTITY_EXTENSIONS.has(ext)) continue;

    const owner = findOwner(file, allOwners);
    if (opts.includeFiles) {
      const fileId = `file:${opts.repo}:${file}`;
      entities.push({
        id: fileId,
        type: "file",
        name: rpath.basename(file),
        attrs: { path: file },
        readers,
      });
      if (owner) {
        facts.push({
          type: "contains",
          from: owner,
          to: fileId,
          attrs: {},
          readers,
        });
      }
    }

    if (!JS_EXTENSIONS.includes(ext)) continue;
    const npmOwner = findOwner(file, npmOwners);
    if (!npmOwner) continue;

    const text = await readRepoFile(root, file);
    if (text === undefined) continue;
    let specifiers: string[];
    try {
      specifiers = extractSpecifiers(text);
    } catch (err) {
      warnings.push(
        `failed to scan imports in ${file}: ${(err as Error).message}`,
      );
      continue;
    }

    for (const specifier of specifiers) {
      if (specifier.startsWith(".")) {
        if (!opts.includeFiles) continue;
        const resolved = resolveRelativeImport(file, specifier, fileSet);
        if (!resolved || resolved === file) continue;
        facts.push({
          type: "imports",
          from: `file:${opts.repo}:${file}`,
          to: `file:${opts.repo}:${resolved}`,
          attrs: {},
          readers,
        });
        continue;
      }

      const depName = packageNameOf(specifier);
      if (!depName) continue;
      const target = nameToPackage.get(depName);
      if (!target || target.entityId === npmOwner) continue;
      const byTarget =
        packageImportFiles.get(npmOwner) ?? new Map<string, Set<string>>();
      packageImportFiles.set(npmOwner, byTarget);
      const fileSetForTarget =
        byTarget.get(target.entityId) ?? new Set<string>();
      byTarget.set(target.entityId, fileSetForTarget);
      fileSetForTarget.add(file);
    }
  }

  for (const [from, byTarget] of packageImportFiles) {
    for (const [to, files] of byTarget) {
      facts.push({
        type: "imports",
        from,
        to,
        attrs: { files: files.size },
        readers,
      });
    }
  }

  return { entities, facts, warnings };
}
