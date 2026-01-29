import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { $ } from "bun";
import { createChildLogger } from "../../shared/lib/logger.ts";

const log = createChildLogger("bun-install");

const CACHE_DIR = "/var/lib/sandbox/registry/packages";

let installLock: Promise<void> | null = null;

function readPackageJson(): Record<string, string> {
  const pkgPath = path.join(CACHE_DIR, "package.json");
  if (!existsSync(pkgPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return (parsed.dependencies as Record<string, string>) ?? {};
  } catch {
    return {};
  }
}

export async function installPackage(
  pkg: string,
  version = "latest",
): Promise<string> {
  if (installLock) {
    await installLock;
  }

  let resolve: () => void;
  installLock = new Promise<void>((r) => {
    resolve = r;
  });

  try {
    await mkdir(CACHE_DIR, { recursive: true });

    const modulePath = path.join(CACHE_DIR, "node_modules", pkg);
    const deps = readPackageJson();

    if (deps[pkg] === version && existsSync(modulePath)) {
      log.debug({ pkg, version }, "Package already installed, skipping");
      return modulePath;
    }

    const pkgJsonPath = path.join(CACHE_DIR, "package.json");
    if (!existsSync(pkgJsonPath)) {
      writeFileSync(
        pkgJsonPath,
        JSON.stringify({ name: "frak-registry-cache", private: true }, null, 2),
      );
    }

    log.info({ pkg, version }, "Installing package");

    const result =
      await $`bun add --force --exact --cwd ${CACHE_DIR} ${`${pkg}@${version}`}`
        .quiet()
        .nothrow();

    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString();
      log.error({ pkg, version, stderr }, "Package installation failed");
      throw new Error(`Failed to install ${pkg}@${version}: ${stderr}`);
    }

    log.info({ pkg, version, path: modulePath }, "Package installed");
    return modulePath;
  } finally {
    resolve!();
    installLock = null;
  }
}

export function isPackageInstalled(pkg: string, version?: string): boolean {
  const modulePath = path.join(CACHE_DIR, "node_modules", pkg);
  if (!existsSync(modulePath)) return false;
  if (!version) return true;

  const deps = readPackageJson();
  return deps[pkg] === version;
}
