/**
 * Atelier v2 server bootstrap. One deployable, three internal modules
 * (atelier-v2 §3.1) — this file is the only place that constructs the
 * composition root and starts listening.
 */
import { validateConfig } from "@frak/atelier-shared";
import { Cron } from "croner";
import {
  createServerContainer,
  wireBuiltinHarnesses,
} from "./api/container.ts";
import { createApp } from "./api/index.ts";
import { initDatabase } from "./control/index.ts";
import { ensureSharedSshPipeKey } from "./runtime/index.ts";
import { config, isMock, isProduction } from "./shared/lib/config.ts";
import { logger } from "./shared/lib/logger.ts";
import { appPaths } from "./shared/lib/paths.ts";

const configErrors = validateConfig(config);
if (configErrors.length > 0 && isProduction()) {
  for (const err of configErrors)
    logger.error({ field: err.field }, err.message);
  logger.fatal("Configuration validation failed. Exiting.");
  process.exit(1);
} else if (configErrors.length > 0) {
  for (const err of configErrors) {
    logger.warn({ field: err.field }, `Config warning: ${err.message}`);
  }
}

logger.info({ dataDir: appPaths.data }, "Using data directory");
await initDatabase();
logger.info({ dbPath: appPaths.database }, "Control database ready");

const container = createServerContainer();
await wireBuiltinHarnesses(container);

await ensureSharedSshPipeKey();

// Sweep zombie records left by a server crash/restart: `creating` → cleanup +
// `error`, `running` without a pod → `error` (both recoverable via resume).
await container.runtime.reconcileOnStartup();

// Recompute each stored prebuild's content key against current remote HEADs
// + base image digest, and rebuild anything that moved (runtime.service.ts
// `refreshStalePrebuilds`). Skipped in mock mode (no network git/registry).
if (!isMock()) {
  // `protect: true` skips a tick if the previous run is still going, so a slow
  // pass (many repos / slow remotes) can't stack overlapping refresh runs.
  new Cron("*/30 * * * *", { protect: true }, () => {
    container.runtime
      .refreshStalePrebuilds()
      .catch((err) => logger.error({ err }, "prebuild staleness cron failed"));
  });
}

const app = createApp(container);

app.listen(
  { port: config.server.port, hostname: config.server.host },
  ({ hostname, port }) => {
    logger.info(
      { hostname, port, swagger: `http://${hostname}:${port}/swagger` },
      "Atelier v2 server started",
    );
  },
);

export type App = typeof app;
