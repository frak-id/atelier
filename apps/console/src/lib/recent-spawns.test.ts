import { describe, expect, test } from "bun:test";
import {
  MAX_RECENT_SPAWNS,
  type RecentSpawn,
  withRecentSpawn,
} from "./recent-spawns.ts";

const spawn = (repo: string, branch?: string): RecentSpawn => ({
  repo,
  branch,
  toolboxes: [],
  resources: { vcpus: "2", memoryMb: "4096" },
  orgId: "org1",
});

describe("withRecentSpawn", () => {
  test("puts the newest first", () => {
    const list = withRecentSpawn([spawn("a/a")], spawn("b/b"));
    expect(list.map((s) => s.repo)).toEqual(["b/b", "a/a"]);
  });

  test("a repeat of the same repo and branch replaces the older entry", () => {
    const first = spawn("a/a", "main");
    const list = withRecentSpawn([spawn("b/b"), first], {
      ...first,
      toolboxes: ["tb"],
    });
    expect(list).toHaveLength(2);
    expect(list[0]?.toolboxes).toEqual(["tb"]);
  });

  test("the same repo on another branch is a separate entry", () => {
    const list = withRecentSpawn([spawn("a/a", "main")], spawn("a/a", "dev"));
    expect(list).toHaveLength(2);
  });

  test("keeps only the last few", () => {
    let list: RecentSpawn[] = [];
    for (let i = 0; i < MAX_RECENT_SPAWNS + 3; i++) {
      list = withRecentSpawn(list, spawn(`r/${i}`));
    }
    expect(list).toHaveLength(MAX_RECENT_SPAWNS);
    expect(list[0]?.repo).toBe(`r/${MAX_RECENT_SPAWNS + 2}`);
  });
});
