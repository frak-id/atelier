/**
 * Atelier server bootstrap. One deployable, three internal modules
 * (design.md §3.1) — this file is the only place that constructs the
 * composition root and starts listening.
 */
import { validateConfig } from "@frak/atelier-shared/config-loader";
import {
  createServerContainer,
  wireBuiltinHarnesses,
} from "./api/container.ts";
import { createApp } from "./api/index.ts";
import { startScheduler } from "./api/scheduler.ts";
import { assertSecretsKeyConfigured, initDatabase } from "./control/index.ts";
import { config, isProduction } from "./shared/lib/config.ts";
import { logger } from "./shared/lib/logger.ts";
import { appPaths } from "./shared/lib/paths.ts";
import { bindRuntimeConfig } from "./shared/lib/runtime-config.ts";
import { startSshGateway } from "./ssh/index.ts";

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
// Throws in production without SANDBOX_SECRETS_KEY (no public default key).
assertSecretsKeyConfigured();

logger.info({ dataDir: appPaths.data }, "Using data directory");
await initDatabase();
logger.info({ dbPath: appPaths.database }, "Control database ready");

const container = createServerContainer();
// Route the runtime-config resolver (registry URL + image builder knobs) at
// the DB-backed config plane so console/env edits apply live. Env-set keys
// stay authoritative and read-only (see ServerConfigService's env lock).
bindRuntimeConfig(container.control.serverConfigService);
await wireBuiltinHarnesses(container);
container.control.defaultOrg.warnIfDefaultOrgUnset();

// The in-server ssh2 gateway binds its own socket and lives for the process
// lifetime, so a redeploy drops live SSH sessions (acceptable for a dev tool).
// Production only: local mode (Docker backend) has no SSH gateway.
const sshGateway = isProduction()
  ? await startSshGateway(container).catch((err) => {
      logger.error({ err }, "in-server ssh gateway failed to start");
      return null;
    })
  : null;

// Sweep zombie records left by a server crash/restart: `creating` → cleanup +
// `error`, `running` without a pod → `error` (both recoverable via resume).
await container.runtime.reconcileOnStartup();
// Same sweep for the image builder: a `building` row with no live in-flight
// build after a restart is a permanent ghost otherwise.
container.images.reconcileOnStartup();
// And for the jobs queue: a restart kills every in-flight op's promise +
// AbortController, so any `running` row is a ghost — fail it "rebooted".
container.jobs.reconcileOnStartup();

startScheduler(container);

const app = createApp(container);

app.listen(
  { port: config.server.port, hostname: config.server.host },
  ({ hostname, port }) => {
    logger.info(
      { hostname, port, swagger: `http://${hostname}:${port}/swagger` },
      "Atelier server started",
    );
  },
);

// Close the SSH listener on shutdown so a redeploy releases the port promptly.
if (sshGateway) {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      void sshGateway.close().finally(() => process.exit(0));
    });
  }
}

export type App = typeof app;
