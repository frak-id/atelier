import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openKnowledgeDb,
  type RepositoryIndex,
  SqliteDocumentStore,
} from "@atelier/knowledge";
import { parseConfig } from "./config.ts";
import { RecapRunner } from "./recaps/runner.ts";
import { createHubServices } from "./services.ts";

const repo = { repo: "acme/shop", branch: "main" };

function setup() {
  let extracts = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const hub = createHubServices(
    parseConfig(
      { dataDir: mkdtempSync(join(tmpdir(), "hub-idx-")), repos: [repo] },
      {},
    ),
    {
      dbPath: ":memory:",
      indexer: {
        // Always the same revision: only `force` makes a re-run happen.
        checkout: async () => "same",
        extract: async (input): Promise<RepositoryIndex> => {
          extracts++;
          await gate;
          return {
            repo: input.repo,
            revision: input.revision,
            entities: [],
            facts: [],
            documents: [],
            warnings: [],
            stats: { files: 0, packages: 0, documents: 0, durationMs: 0 },
          };
        },
      },
    },
  );
  return { hub, release, extracts: () => extracts };
}

async function settle(hub: ReturnType<typeof setup>["hub"]) {
  for (let i = 0; i < 200 && hub.indexer.isRunning(repo.repo); i++) {
    await Bun.sleep(5);
  }
}

describe("IndexRunner", () => {
  test("triggers during a run collapse into one follow-up, keeping force", async () => {
    const { hub, release, extracts } = setup();
    const first = hub.indexer.trigger(repo, "push:1");
    void hub.indexer.trigger(repo, "manual", true);
    void hub.indexer.trigger(repo, "push:2");
    release();
    expect((await first).status).toBe("succeeded");
    await Bun.sleep(5);
    await settle(hub);
    const runs = hub.indexer.runs({ repo: repo.repo });
    expect(runs.map((r) => r.status)).toEqual(["succeeded", "succeeded"]);
    expect(extracts()).toBe(2);
  });

  test("an unforced run at an indexed revision is skipped", async () => {
    const { hub, release } = setup();
    release();
    await hub.indexer.trigger(repo, "a");
    expect((await hub.indexer.trigger(repo, "b")).status).toBe("skipped");
    expect((await hub.indexer.trigger(repo, "c", true)).status).toBe(
      "succeeded",
    );
  });
});

describe("IndexRunner + recaps", () => {
  test("no recap runner configured: the index run still succeeds", async () => {
    const { hub, release } = setup();
    release();
    const run = await hub.indexer.trigger(repo, "push");
    expect(run.status).toBe("succeeded");
    expect(run.recaps).toEqual({
      skipped: "recaps disabled, or no llm api key configured",
    });
  });

  test("a repo with recaps: false is skipped even with a recap runner", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hub-idx-"));
    const db = openKnowledgeDb(":memory:");
    const documents = new SqliteDocumentStore(db);
    const recaps = new RecapRunner({
      db,
      documents,
      llm: {
        baseUrl: "http://x",
        api: "anthropic-messages",
        model: "m",
        thinking: "medium",
      },
      apiKey: "k",
      piCommand: ["pi"],
      concurrency: 1,
      timeoutMinutes: 1,
      maxAreas: 10,
      agent: async () => {
        throw new Error("should never be called");
      },
    });
    const hub = createHubServices(
      parseConfig({ dataDir, repos: [{ ...repo, recaps: false }] }, {}),
      {
        dbPath: ":memory:",
        indexer: {
          checkout: async () => "same",
          extract: async (input): Promise<RepositoryIndex> => ({
            repo: input.repo,
            revision: input.revision,
            entities: [],
            facts: [],
            documents: [],
            warnings: [],
            stats: { files: 0, packages: 0, documents: 0, durationMs: 0 },
          }),
          recaps,
        },
      },
    );
    const run = await hub.indexer.trigger({ ...repo, recaps: false }, "push");
    expect(run.status).toBe("succeeded");
    expect(run.recaps).toEqual({ skipped: "recaps disabled for this repo" });
  });

  test("a recap failure is recorded on the run but never fails it", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hub-idx-"));
    const db = openKnowledgeDb(":memory:");
    const documents = new SqliteDocumentStore(db);
    const recaps = new RecapRunner({
      db,
      documents,
      llm: {
        baseUrl: "http://x",
        api: "anthropic-messages",
        model: "m",
        thinking: "medium",
      },
      apiKey: "k",
      piCommand: ["pi"],
      concurrency: 1,
      timeoutMinutes: 1,
      maxAreas: 10,
      agent: async () => {
        throw new Error("pi crashed");
      },
    });
    const hub = createHubServices(parseConfig({ dataDir, repos: [repo] }, {}), {
      dbPath: ":memory:",
      indexer: {
        checkout: async () => "same",
        extract: async (input): Promise<RepositoryIndex> => ({
          repo: input.repo,
          revision: input.revision,
          entities: [],
          facts: [],
          documents: [],
          warnings: [],
          stats: { files: 0, packages: 0, documents: 0, durationMs: 0 },
        }),
        recaps,
      },
    });
    const run = await hub.indexer.trigger(repo, "push");
    expect(run.status).toBe("succeeded");
    expect(run.recaps).toEqual({ error: "pi crashed" });
  });
});
