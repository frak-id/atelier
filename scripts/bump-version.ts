#!/usr/bin/env bun
/**
 * Bump version across the workspace packages, the Rust agent (`apps/agent`)
 * and the default agent image pin.
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
  "apps/server/package.json",
  "apps/console/package.json",
  "packages/shared/package.json",
];

/**
 * Files that pin the default in-pod agent image to the release version
 * (`ghcr.io/frak-id/sandbox-agent:<version>`, published by release.yml next to
 * `:latest`). The server and the agent it bakes into base images move
 * together, so a rebuilt base never pulls an agent from another release.
 */
const AGENT_IMAGE_PIN_PATHS = [
  "packages/shared/src/config.schema.ts",
  "packages/shared/schemas/atelier.config.schema.json",
  "packages/shared/schemas/sandbox.config.full-example.json",
  "apps/server/src/control/modules/server-config/registry.ts",
  "apps/server/src/runtime/registry/seeds/dev-base/Dockerfile",
];
const AGENT_IMAGE_PIN_RE = /(ghcr\.io\/frak-id\/sandbox-agent:)\d+\.\d+\.\d+/g;

const CARGO_TOML_PATH = "apps/agent/Cargo.toml";
const CARGO_LOCK_PATH = "apps/agent/Cargo.lock";
const CARGO_CRATE_NAME = "atelier-agent";

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

/**
 * Keep Cargo.lock in lockstep with Cargo.toml. The agent Docker build runs
 * `cargo build --locked`, which aborts if the lockfile's recorded version for
 * the local crate drifts from Cargo.toml — so bumping the manifest without
 * touching the lockfile breaks every release build. The crate is a path member
 * with no checksum, so a targeted version replacement in its `[[package]]`
 * block is sufficient (no network / cargo toolchain needed).
 */
function updateCargoLock(filePath: string, newVersion: string): void {
  const fullPath = resolve(ROOT, filePath);
  const content = readFileSync(fullPath, "utf-8");

  const re = new RegExp(`(name = "${CARGO_CRATE_NAME}"\\nversion = )"[^"]*"`);
  const replaced = content.replace(re, `$1"${newVersion}"`);

  if (replaced === content) {
    throw new Error(
      `Could not find ${CARGO_CRATE_NAME} version entry in ${filePath}`,
    );
  }

  writeFileSync(fullPath, replaced);
}

function updateAgentImagePin(filePath: string, newVersion: string): void {
  const fullPath = resolve(ROOT, filePath);
  const content = readFileSync(fullPath, "utf-8");
  if (!content.match(AGENT_IMAGE_PIN_RE)) {
    throw new Error(`Could not find the agent image pin in ${filePath}`);
  }

  writeFileSync(
    fullPath,
    content.replace(AGENT_IMAGE_PIN_RE, `$1${newVersion}`),
  );
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

updateCargoLock(CARGO_LOCK_PATH, next);
console.log(`  ✓ ${CARGO_LOCK_PATH}`);

for (const pinPath of AGENT_IMAGE_PIN_PATHS) {
  updateAgentImagePin(pinPath, next);
  console.log(`  ✓ ${pinPath} (agent image pin)`);
}

console.log(`\nDone. All manifests updated to ${next}.`);
