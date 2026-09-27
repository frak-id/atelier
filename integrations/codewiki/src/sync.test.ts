import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { SyncConfig } from "./config.ts";
import type { OnyxDocument } from "./pages.ts";
import { diffPages, syncAll, syncOne } from "./sync.ts";

const fixtureWikiDir = path.join(import.meta.dir, "__fixtures__", "wiki");
const atelierRef = { owner: "frak-id", repo: "atelier", branch: "main" };

function baseConfig(
  dataDir: string,
  overrides: Partial<SyncConfig> = {},
): SyncConfig {
  return {
    repos: [{ owner: "frak-id", repo: "atelier", branch: "main" }],
    githubToken: undefined,
    dataDir,
    llmBaseUrl: "http://cliproxy:8317/v1",
    llmApiKey: "sk-test",
    codewikiModel: "claude-sonnet-5",
    codewikiFallbackModel: "claude-haiku-4-5",
    codewikiMaxTokens: 64000,
    codewikiExclude: undefined,
    onyxUrl: "http://onyx-api-service.onyx.svc.cluster.local:8080",
    onyxApiKey: "onyx-key",
    onyxCcPairId: 7,
    dryRun: false,
    ...overrides,
  };
}

describe("diffPages", () => {
  test("upserts everything when there's no previous state", () => {
    const diff = diffPages({ a: "h1", b: "h2" }, undefined);
    expect(diff.upsertIds.sort()).toEqual(["a", "b"]);
    expect(diff.deleteIds).toEqual([]);
  });

  test("only upserts changed/new pages", () => {
    const diff = diffPages(
      { a: "h1-new", b: "h2" },
      { lastCommit: "x", pages: { a: "h1-old", b: "h2" } },
    );
    expect(diff.upsertIds).toEqual(["a"]);
    expect(diff.deleteIds).toEqual([]);
  });

  test("deletes pages no longer present", () => {
    const diff = diffPages(
      { a: "h1" },
      { lastCommit: "x", pages: { a: "h1", b: "h2" } },
    );
    expect(diff.upsertIds).toEqual([]);
    expect(diff.deleteIds).toEqual(["b"]);
  });
});

describe("syncOne (local mode, skipGenerate)", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "codewiki-sync-test-"));
    const wikiDir = path.join(dataDir, "wiki", "frak-id", "atelier");
    await mkdir(wikiDir, { recursive: true });
    await cp(fixtureWikiDir, wikiDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  test("upserts every page on first sync and saves state", async () => {
    const config = baseConfig(dataDir);
    const upserted: OnyxDocument[] = [];
    const deleted: string[] = [];

    const result = await syncOne({
      config,
      ref: atelierRef,
      localPath: "/unused-because-skipGenerate",
      skipGenerate: true,
      onyx: {
        upsert: async (doc) => {
          upserted.push(doc);
        },
        delete: async (id) => {
          deleted.push(id);
        },
      },
    });

    expect(result.status).toBe("synced");
    if (result.status !== "synced") throw new Error("unreachable");
    expect(result.upserted.sort()).toEqual([
      "codewiki:frak-id/atelier:CI_CD_Workflows",
      "codewiki:frak-id/atelier:Repository_Configuration_&_Tooling",
    ]);
    expect(result.deleted).toEqual([]);
    expect(upserted).toHaveLength(2);
    expect(deleted).toEqual([]);

    const statePath = path.join(dataDir, "state", "frak-id__atelier.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    expect(Object.keys(state.pages).sort()).toEqual([
      "codewiki:frak-id/atelier:CI_CD_Workflows",
      "codewiki:frak-id/atelier:Repository_Configuration_&_Tooling",
    ]);
    expect(state.lastCommit).toBe("abc123def4567890abc123def4567890abcdef1");
  });

  test("a second sync with no page changes upserts nothing", async () => {
    const config = baseConfig(dataDir);
    let upsertCount = 0;

    await syncOne({
      config,
      ref: atelierRef,
      localPath: "/unused",
      skipGenerate: true,
      onyx: { upsert: async () => {}, delete: async () => {} },
    });

    const result = await syncOne({
      config,
      ref: atelierRef,
      localPath: "/unused",
      skipGenerate: true,
      onyx: {
        upsert: async () => {
          upsertCount++;
        },
        delete: async () => {},
      },
    });

    expect(result.status).toBe("synced");
    if (result.status !== "synced") throw new Error("unreachable");
    expect(result.upserted).toEqual([]);
    expect(upsertCount).toBe(0);
  });

  test("removes a page from Onyx once its file disappears", async () => {
    const config = baseConfig(dataDir);
    await syncOne({
      config,
      ref: atelierRef,
      localPath: "/unused",
      skipGenerate: true,
      onyx: { upsert: async () => {}, delete: async () => {} },
    });

    const wikiDir = path.join(dataDir, "wiki", "frak-id", "atelier");
    await rm(path.join(wikiDir, "Repository_Configuration_&_Tooling.md"));

    const deleted: string[] = [];
    const result = await syncOne({
      config,
      ref: atelierRef,
      localPath: "/unused",
      skipGenerate: true,
      onyx: {
        upsert: async () => {},
        delete: async (id) => {
          deleted.push(id);
        },
      },
    });

    expect(result.status).toBe("synced");
    expect(deleted).toEqual([
      "codewiki:frak-id/atelier:Repository_Configuration_&_Tooling",
    ]);
  });

  test("dry run pushes nothing and writes no state", async () => {
    const config = baseConfig(dataDir, { dryRun: true });
    let calls = 0;
    const result = await syncOne({
      config,
      ref: atelierRef,
      localPath: "/unused",
      skipGenerate: true,
      onyx: {
        upsert: async () => {
          calls++;
        },
        delete: async () => {
          calls++;
        },
      },
    });

    expect(result.status).toBe("synced");
    expect(calls).toBe(0);
    const statePath = path.join(dataDir, "state", "frak-id__atelier.json");
    await expect(readFile(statePath, "utf8")).rejects.toThrow();
  });
});

describe("syncAll", () => {
  test("skips a repo whose remote HEAD matches saved state", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "codewiki-sync-test-"));
    try {
      const statePath = path.join(dataDir, "state", "frak-id__atelier.json");
      await mkdir(path.dirname(statePath), { recursive: true });
      await Bun.write(
        statePath,
        JSON.stringify({ lastCommit: "same-sha", pages: {} }),
      );

      const config = baseConfig(dataDir);
      const { results, failed } = await syncAll({
        config,
        git: {
          remoteHeadSha: async () => "same-sha",
          fetchBranch: async () => {
            throw new Error("should not fetch when unchanged");
          },
        },
      });

      expect(failed).toBe(false);
      expect(results).toEqual([
        {
          repo: "frak-id/atelier",
          status: "skipped",
          reason: "unchanged at same-sha",
        },
      ]);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("one repo failing does not stop the others", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "codewiki-sync-test-"));
    try {
      const config = baseConfig(dataDir, {
        repos: [
          { owner: "frak-id", repo: "broken", branch: "main" },
          { owner: "frak-id", repo: "atelier", branch: "main" },
        ],
      });
      await mkdir(path.join(dataDir, "wiki", "frak-id", "atelier"), {
        recursive: true,
      });
      await cp(
        fixtureWikiDir,
        path.join(dataDir, "wiki", "frak-id", "atelier"),
        { recursive: true },
      );

      const { results, failed } = await syncAll({
        config,
        skipGenerate: true,
        git: {
          remoteHeadSha: async (ref) => {
            if (ref.repo === "broken") throw new Error("network down");
            return "sha-atelier";
          },
          fetchBranch: async () => "sha-atelier",
        },
        onyx: { upsert: async () => {}, delete: async () => {} },
      });

      expect(failed).toBe(true);
      expect(results).toHaveLength(2);
      expect(results[0]).toMatchObject({
        repo: "frak-id/broken",
        status: "failed",
      });
      expect(results[1]).toMatchObject({
        repo: "frak-id/atelier",
        status: "synced",
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("onlyRepo filters to a single configured repo", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "codewiki-sync-test-"));
    try {
      const config = baseConfig(dataDir, {
        repos: [
          { owner: "frak-id", repo: "atelier", branch: "main" },
          { owner: "frak-id", repo: "onyx", branch: "main" },
        ],
      });
      const { results } = await syncAll({
        config,
        onlyRepo: "frak-id/onyx",
        git: {
          remoteHeadSha: async () => "sha",
          fetchBranch: async () => "sha",
        },
        skipGenerate: true,
        onyx: { upsert: async () => {}, delete: async () => {} },
      });
      // wiki dir for onyx doesn't exist -> readdir fails -> status failed,
      // but the important assertion is that only one repo ran at all.
      expect(results).toHaveLength(1);
      expect(results[0]?.repo).toBe("frak-id/onyx");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("an unknown --repo fails clearly", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "codewiki-sync-test-"));
    try {
      const config = baseConfig(dataDir);
      const { results, failed } = await syncAll({
        config,
        onlyRepo: "frak-id/does-not-exist",
      });
      expect(failed).toBe(true);
      expect(results[0]?.status).toBe("failed");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
