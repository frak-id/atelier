import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepositoryIndex } from "@atelier/knowledge";
import { parseConfig } from "./config.ts";
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
