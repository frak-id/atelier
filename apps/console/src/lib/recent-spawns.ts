import { type Static, Type } from "@sinclair/typebox";
import { Check } from "@sinclair/typebox/value";

const RecentSpawnSchema = Type.Object({
  repo: Type.String(),
  branch: Type.Optional(Type.String()),
  toolboxes: Type.Array(Type.String()),
  resources: Type.Object({ vcpus: Type.String(), memoryMb: Type.String() }),
  orgId: Type.String(),
});
const RecentSpawnsSchema = Type.Array(RecentSpawnSchema);

/** What it takes to spawn the same thing again (the repo card's choices plus
 * the page's shared options). */
export type RecentSpawn = Static<typeof RecentSpawnSchema>;

const STORAGE_KEY = "atelier.recentSpawns";
export const MAX_RECENT_SPAWNS = 5;

function sameTarget(a: RecentSpawn, b: RecentSpawn): boolean {
  return a.repo === b.repo && (a.branch ?? "") === (b.branch ?? "");
}

/** Newest first; a repeat of the same repo+branch replaces its older entry. */
export function withRecentSpawn(
  list: readonly RecentSpawn[],
  entry: RecentSpawn,
): RecentSpawn[] {
  return [entry, ...list.filter((item) => !sameTarget(item, entry))].slice(
    0,
    MAX_RECENT_SPAWNS,
  );
}

export function loadRecentSpawns(): RecentSpawn[] {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? "[]",
    );
    return Check(RecentSpawnsSchema, parsed)
      ? parsed.slice(0, MAX_RECENT_SPAWNS)
      : [];
  } catch {
    return [];
  }
}

export function saveRecentSpawns(list: readonly RecentSpawn[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Private mode / quota: recents are a convenience, never an error.
  }
}
