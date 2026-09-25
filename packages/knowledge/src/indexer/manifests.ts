/**
 * Manifest extraction: the repo entity, npm/Cargo/pypi/go package entities,
 * `contains`/`depends_on` facts. Bad manifests are warnings, not throws —
 * one broken `package.json` shouldn't fail an entire index run.
 */
import type { EntityInput, FactInput, Readers } from "../types.ts";
import { readRepoFile, rpath } from "./files.ts";
import type { CrateInfo, PackageInfo } from "./model.ts";
import { extractReadmeLede } from "./readme.ts";

export interface ManifestScanResult {
  entities: EntityInput[];
  facts: FactInput[];
  warnings: string[];
  npmPackages: PackageInfo[];
  crates: CrateInfo[];
}

export interface ScanOpts {
  repo: string;
  revision: string;
  readers: Readers;
  webUrl?: string;
  includeExternalDeps: boolean;
}

const NPM_DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

const CARGO_DEP_FIELDS = [
  "dependencies",
  "dev-dependencies",
  "build-dependencies",
] as const;

function dirOf(path: string): string {
  const d = rpath.dirname(path);
  return d === "." ? "" : d;
}

function isNodeModulesPath(path: string): boolean {
  return path.split("/").includes("node_modules");
}

async function findDirReadme(
  root: string,
  files: Set<string>,
  dir: string,
): Promise<string | undefined> {
  const direct = dir === "" ? "README.md" : `${dir}/README.md`;
  if (files.has(direct)) return readRepoFile(root, direct);
  const prefix = dir === "" ? "" : `${dir}/`;
  for (const f of files) {
    if (
      f.slice(prefix.length).toLowerCase() === "readme.md" &&
      f.startsWith(prefix)
    ) {
      return readRepoFile(root, f);
    }
  }
  return undefined;
}

export async function scanManifests(
  root: string,
  files: string[],
  opts: ScanOpts,
): Promise<ManifestScanResult> {
  const warnings: string[] = [];
  const entities: EntityInput[] = [];
  const facts: FactInput[] = [];
  const fileSet = new Set(files);
  const { readers } = opts;
  const repoEntityId = `repo:${opts.repo}`;

  const repoReadme = await findDirReadme(root, fileSet, "");
  entities.push({
    id: repoEntityId,
    type: "repo",
    name: opts.repo,
    summary: repoReadme ? extractReadmeLede(repoReadme) : undefined,
    attrs: {
      revision: opts.revision,
      ...(opts.webUrl ? { webUrl: opts.webUrl } : {}),
    },
    readers,
  });

  // ── npm packages ──────────────────────────────────────────────────────
  const npmPackages: PackageInfo[] = [];
  const npmParsed: { dir: string; json: Record<string, unknown> }[] = [];
  for (const file of files) {
    if (isNodeModulesPath(file)) continue;
    if (rpath.basename(file) !== "package.json") continue;
    const text = await readRepoFile(root, file);
    if (text === undefined) continue;
    try {
      const json = JSON.parse(text) as Record<string, unknown>;
      const dir = dirOf(file);
      const name = typeof json.name === "string" ? json.name : undefined;
      if (!name) {
        if (dir !== "") warnings.push(`package.json without a name: ${file}`);
        continue;
      }
      npmParsed.push({ dir, json: { ...json, name } });
    } catch (err) {
      warnings.push(`unparseable manifest ${file}: ${(err as Error).message}`);
    }
  }
  const npmNameToEntity = new Map<string, string>();
  for (const { json } of npmParsed) {
    const name = json.name as string;
    npmNameToEntity.set(name, `package:${name}`);
  }

  for (const { dir, json } of npmParsed) {
    const name = json.name as string;
    const entityId = `package:${name}`;
    npmPackages.push({ entityId, name, dir });
    const description =
      typeof json.description === "string" ? json.description : undefined;
    const summary =
      description ??
      extractReadmeLede((await findDirReadme(root, fileSet, dir)) ?? "");
    entities.push({
      id: entityId,
      type: "package",
      name,
      summary: summary || undefined,
      attrs: {
        path: dir,
        ...(typeof json.version === "string" ? { version: json.version } : {}),
        private: json.private === true,
        ecosystem: "npm",
      },
      readers,
    });
    facts.push({
      type: "contains",
      from: repoEntityId,
      to: entityId,
      attrs: {},
      readers,
    });

    for (const field of NPM_DEP_FIELDS) {
      const deps = json[field];
      if (!deps || typeof deps !== "object") continue;
      for (const [depName] of Object.entries(deps as Record<string, unknown>)) {
        const internal = npmNameToEntity.get(depName);
        if (internal) {
          if (internal === entityId) continue;
          facts.push({
            type: "depends_on",
            from: entityId,
            to: internal,
            attrs: { kind: field },
            readers,
          });
        } else if (opts.includeExternalDeps) {
          const depId = `dependency:npm:${depName}`;
          if (!entities.some((e) => e.id === depId)) {
            entities.push({
              id: depId,
              type: "dependency",
              name: depName,
              attrs: { ecosystem: "npm" },
              readers,
            });
          }
          facts.push({
            type: "depends_on",
            from: entityId,
            to: depId,
            attrs: { kind: field },
            readers,
          });
        }
      }
    }
  }

  // ── Rust crates ───────────────────────────────────────────────────────
  const crates: CrateInfo[] = [];
  const cargoParsed: {
    dir: string;
    file: string;
    toml: Record<string, unknown>;
  }[] = [];
  for (const file of files) {
    if (rpath.basename(file) !== "Cargo.toml") continue;
    const text = await readRepoFile(root, file);
    if (text === undefined) continue;
    try {
      const toml = Bun.TOML.parse(text) as Record<string, unknown>;
      cargoParsed.push({ dir: dirOf(file), file, toml });
    } catch (err) {
      warnings.push(`unparseable manifest ${file}: ${(err as Error).message}`);
    }
  }
  const crateDirToEntity = new Map<string, string>();
  const crateNameToEntity = new Map<string, string>();
  for (const { dir, toml } of cargoParsed) {
    const pkg = toml.package as Record<string, unknown> | undefined;
    if (!pkg || typeof pkg.name !== "string") continue;
    const entityId = `crate:${pkg.name}`;
    crateDirToEntity.set(dir, entityId);
    crateNameToEntity.set(pkg.name, entityId);
  }
  for (const { dir, toml } of cargoParsed) {
    const pkg = toml.package as Record<string, unknown> | undefined;
    if (!pkg || typeof pkg.name !== "string") continue;
    const name = pkg.name;
    const entityId = `crate:${name}`;
    crates.push({ entityId, name, dir });
    entities.push({
      id: entityId,
      type: "crate",
      name,
      summary:
        typeof pkg.description === "string" ? pkg.description : undefined,
      attrs: {
        path: dir,
        ...(typeof pkg.version === "string" ? { version: pkg.version } : {}),
        ecosystem: "cargo",
      },
      readers,
    });
    facts.push({
      type: "contains",
      from: repoEntityId,
      to: entityId,
      attrs: {},
      readers,
    });

    for (const field of CARGO_DEP_FIELDS) {
      const deps = toml[field];
      if (!deps || typeof deps !== "object") continue;
      for (const [depKey, spec] of Object.entries(
        deps as Record<string, unknown>,
      )) {
        const table =
          spec && typeof spec === "object"
            ? (spec as Record<string, unknown>)
            : undefined;
        const depPath =
          table && typeof table.path === "string" ? table.path : undefined;
        const depRealName =
          table && typeof table.package === "string" ? table.package : depKey;

        let target: string | undefined;
        if (depPath) {
          const resolved = rpath.normalize(rpath.join(dir, depPath));
          target = crateDirToEntity.get(resolved === "." ? "" : resolved);
        }
        if (!target) target = crateNameToEntity.get(depRealName);
        if (!target) continue;
        if (target === entityId) continue;
        facts.push({
          type: "depends_on",
          from: entityId,
          to: target,
          attrs: { kind: field },
          readers,
        });
      }
    }
  }

  // ── Python (minimal) ─────────────────────────────────────────────────
  for (const file of files) {
    if (rpath.basename(file) !== "pyproject.toml") continue;
    const text = await readRepoFile(root, file);
    if (text === undefined) continue;
    try {
      const toml = Bun.TOML.parse(text) as Record<string, unknown>;
      const project = toml.project as Record<string, unknown> | undefined;
      if (!project || typeof project.name !== "string") continue;
      const dir = dirOf(file);
      const entityId = `package:pypi:${project.name}`;
      entities.push({
        id: entityId,
        type: "package",
        name: project.name,
        summary:
          typeof project.description === "string"
            ? project.description
            : undefined,
        attrs: {
          path: dir,
          ...(typeof project.version === "string"
            ? { version: project.version }
            : {}),
          ecosystem: "pypi",
        },
        readers,
      });
      facts.push({
        type: "contains",
        from: repoEntityId,
        to: entityId,
        attrs: {},
        readers,
      });
    } catch (err) {
      warnings.push(`unparseable manifest ${file}: ${(err as Error).message}`);
    }
  }

  // ── Go (minimal) ──────────────────────────────────────────────────────
  for (const file of files) {
    if (rpath.basename(file) !== "go.mod") continue;
    const text = await readRepoFile(root, file);
    if (text === undefined) continue;
    const match = /^module\s+(\S+)/m.exec(text);
    if (!match) {
      warnings.push(`unparseable manifest ${file}: no module directive`);
      continue;
    }
    const moduleName = match[1] as string;
    const dir = dirOf(file);
    const entityId = `package:go:${moduleName}`;
    entities.push({
      id: entityId,
      type: "package",
      name: moduleName,
      attrs: { path: dir, ecosystem: "go" },
      readers,
    });
    facts.push({
      type: "contains",
      from: repoEntityId,
      to: entityId,
      attrs: {},
      readers,
    });
  }

  return { entities, facts, warnings, npmPackages, crates };
}
