#!/usr/bin/env bun
/**
 * Bump version across all workspace packages and the Rust agent.
 *
 * Usage:
 *   bun run scripts/bump-version.ts patch
 *   bun run scripts/bump-version.ts minor
 *   bun run scripts/bump-version.ts major
 *   bun run scripts/bump-version.ts 1.2.3
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

const PACKAGE_JSON_PATHS = [
  "package.json",
  "apps/manager/package.json",
  "apps/dashboard/package.json",
  "apps/cli/package.json",
  "packages/shared/package.json",
];

const CARGO_TOML_PATH = "apps/agent-rust/Cargo.toml";

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

function parseVersion(version: string): [number, number, number] {
  const parts = version.split(".").map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    throw new Error(`Invalid semver: ${version}`);
  }
  return parts as [number, number, number];
}

function bumpVersion(
  current: string,
  bump: "patch" | "minor" | "major",
): string {
  const [major, minor, patch] = parseVersion(current);
  switch (bump) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
  }
}

function getCurrentVersion(): string {
  const rootPkg = JSON.parse(
    readFileSync(resolve(ROOT, "package.json"), "utf-8"),
  );
  const version = rootPkg.version;
  if (!version || !SEMVER_RE.test(version)) {
    throw new Error(
      `Root package.json has no valid version field (got: ${version})`,
    );
  }
  return version;
}

function updatePackageJson(filePath: string, newVersion: string): void {
  const fullPath = resolve(ROOT, filePath);
  const content = readFileSync(fullPath, "utf-8");
  const pkg = JSON.parse(content);

  pkg.version = newVersion;

  const indent = content.match(/^(\s+)"/m)?.[1] ?? "  ";
  writeFileSync(fullPath, `${JSON.stringify(pkg, null, indent)}\n`);
}

function updateCargoToml(filePath: string, newVersion: string): void {
  const fullPath = resolve(ROOT, filePath);
  const content = readFileSync(fullPath, "utf-8");

  const replaced = content.replace(
    /^(version\s*=\s*)"[^"]*"/m,
    `$1"${newVersion}"`,
  );

  if (replaced === content) {
    throw new Error(`Could not find version field in ${filePath}`);
  }

  writeFileSync(fullPath, replaced);
}

const arg = process.argv[2];

if (!arg) {
  console.error("Usage: bump-version.ts <patch|minor|major|X.Y.Z>");
  process.exit(1);
}

const current = getCurrentVersion();
let next: string;

if (["patch", "minor", "major"].includes(arg)) {
  next = bumpVersion(current, arg as "patch" | "minor" | "major");
} else if (SEMVER_RE.test(arg)) {
  next = arg;
} else {
  console.error(`Invalid argument: ${arg}`);
  console.error("Expected: patch, minor, major, or explicit X.Y.Z");
  process.exit(1);
}

if (next === current) {
  console.error(`Version is already ${current}`);
  process.exit(1);
}

console.log(`Bumping ${current} → ${next}\n`);

for (const pkgPath of PACKAGE_JSON_PATHS) {
  updatePackageJson(pkgPath, next);
  console.log(`  ✓ ${pkgPath}`);
}

updateCargoToml(CARGO_TOML_PATH, next);
console.log(`  ✓ ${CARGO_TOML_PATH}`);

console.log(`\nDone. All manifests updated to ${next}.`);
