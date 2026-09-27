#!/usr/bin/env bun
/** Entry point: `bun run src/index.ts [--repo owner/repo] [--path dir]`.
 *
 * Env:
 *   FORCE=1          sync even if the remote HEAD hasn't moved
 *   SKIP_GENERATE=1  skip invoking the `codewiki` CLI, read the wiki dir
 *                    as-is (for local/dry-run trials against a fixture)
 */

import { loadConfig } from "./config.ts";
import { syncAll } from "./sync.ts";

function parseArgs(argv: string[]) {
  let repo: string | undefined;
  let localPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--repo") {
      repo = argv[++i];
    } else if (arg === "--path") {
      localPath = argv[++i];
    }
  }
  return { repo, localPath };
}

async function main() {
  const { repo, localPath } = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const force = ["1", "true"].includes((process.env.FORCE ?? "").toLowerCase());
  const skipGenerate = ["1", "true"].includes(
    (process.env.SKIP_GENERATE ?? "").toLowerCase(),
  );

  const { results, failed } = await syncAll({
    config,
    force,
    onlyRepo: repo,
    localPath,
    skipGenerate,
    log: (line) => console.log(line),
  });

  for (const result of results) {
    if (result.status === "skipped") {
      console.log(`[skip] ${result.repo}: ${result.reason}`);
    } else if (result.status === "synced") {
      console.log(
        `[sync] ${result.repo}: upserted=${result.upserted.length} ` +
          `deleted=${result.deleted.length} commit=${result.commit ?? "?"}`,
      );
    } else {
      console.error(`[fail] ${result.repo}: ${result.error}`);
    }
  }

  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
