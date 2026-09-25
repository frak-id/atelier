/**
 * Internal shapes threaded between indexer modules. Not part of the public
 * `@atelier/knowledge` contract (that's `../types.ts`).
 */

/** An npm package found in the repo (root included when it has a name). */
export interface PackageInfo {
  entityId: string;
  name: string;
  /** Repo-relative directory, `""` for the root. */
  dir: string;
}

/** A Rust crate (a `Cargo.toml` with a `[package]` table). */
export interface CrateInfo {
  entityId: string;
  name: string;
  dir: string;
}

/** A directory → owning-entity mapping, sorted deepest-first for lookup. */
export interface OwnerEntry {
  dir: string;
  entityId: string;
}

/** Sorts owners so the deepest (longest) directory is tried first. */
export function sortOwners(owners: OwnerEntry[]): OwnerEntry[] {
  return [...owners].sort((a, b) => b.dir.length - a.dir.length);
}

/** The entity owning `filePath`: the deepest owner dir that contains it. */
export function findOwner(
  filePath: string,
  sortedOwners: OwnerEntry[],
): string | undefined {
  for (const o of sortedOwners) {
    if (
      o.dir === "" ||
      filePath === o.dir ||
      filePath.startsWith(`${o.dir}/`)
    ) {
      return o.entityId;
    }
  }
  return undefined;
}
