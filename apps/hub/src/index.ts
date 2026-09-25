/**
 * `@atelier/hub` entry point. See `apps/hub/README.md`.
 */
import { createHubApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createLogger } from "./logger.ts";
import { createHubServices } from "./services.ts";

const log = createLogger("hub");

const config = loadConfig();
const hub = createHubServices(config);
const app = createHubApp(hub);

Bun.serve({ port: config.port, fetch: (request) => app.handle(request) });
log.info(
  {
    port: config.port,
    repos: config.repos.length,
    tokens: config.tokens.length,
    webhooks: Boolean(config.secrets.webhookSecret),
    embeddings: config.embeddings?.provider ?? "off",
  },
  "hub listening",
);

function reindexAll(trigger: string): void {
  for (const repo of config.repos) void hub.indexer.trigger(repo, trigger);
}

// Webhooks are the fast path; the interval catches missed deliveries and
// bootstraps a fresh install. Unchanged revisions are skipped cheaply.
reindexAll("startup");
if (config.reindexIntervalMinutes > 0) {
  setInterval(
    () => reindexAll("interval"),
    config.reindexIntervalMinutes * 60_000,
  );
}
