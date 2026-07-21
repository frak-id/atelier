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
import { config, isLocal, isMock, isProduction } from "./shared/lib/config.ts";
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

logger.info({ dataDir: appPaths.data }, "Using data directory");
await initDatabase();
logger.info({ dbPath: appPaths.database }, "Control database ready");

const container = createServerContainer();
// Route the runtime-config resolver (registry URL + image builder knobs) at
// the DB-backed config plane so console/env edits apply live. Env-set keys
// stay authoritative and read-only (see ServerConfigService's env lock).
bindRuntimeConfig(container.control.serverConfigService);
await wireBuiltinHarnesses(container);

// The shared SSH pipe key is only needed by strategies that proxy through it
// (`sshpiper`, `in-server`); `none` mounts the dev's own keys per-sandbox, so
// pre-warming a shared k8s Secret there would be dead infra (proposal §5).
// Skipped in mock (no runtime) and local (Docker backend, no cluster/sshpiper —
// its k8s Secret provisioning would fail against a nonexistent API server).
if (config.domain.ssh.gateway !== "none" && !isMock() && !isLocal()) {
  await ensureSharedSshPipeKey();
}
// The in-server ssh2 proxy replaces the external sshpiper (proposal §5). It
// binds its own socket and lives for the process lifetime, so a redeploy drops
// live SSH sessions (acceptable for a dev tool). Skipped in mock + local modes.
const sshGateway =
  config.domain.ssh.gateway === "in-server" && !isMock() && !isLocal()
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

// The `jobs` table is append-only (one row per long op forever), so retain a
// bounded history: prune terminal rows older than a week, hourly. Unlike the
// prebuild/git cron below, this runs in every mode (no network needed).
const JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
container.jobs.pruneTerminal(JOB_RETENTION_MS);
new Cron("23 * * * *", { protect: true }, () => {
  try {
    container.jobs.pruneTerminal(JOB_RETENTION_MS);
  } catch (err) {
    logger.error({ err }, "jobs retention prune failed");
  }
});

// Recompute each stored prebuild's content key against current remote HEADs
// + base image digest, and rebuild anything that moved (runtime.service.ts
// `refreshStalePrebuilds`), then enforce the retention window. Both are gated
// on the `prebuild.gitTracking` config (read every tick, so a live toggle
// takes effect without a restart). Skipped in mock mode (no network git).
if (!isMock()) {
  // `protect: true` skips a tick if the previous run is still going, so a slow
  // pass (many repos / slow remotes) can't stack overlapping refresh runs.
  new Cron("*/30 * * * *", { protect: true }, async () => {
    const { serverConfigService } = container.control;
    if (!serverConfigService.get("prebuild.gitTracking")) return;
    try {
      await container.runtime.refreshStalePrebuilds();
      await container.runtime.pruneUnusedPrebuilds(
        serverConfigService.get("prebuild.pruneKeep"),
      );
    } catch (err) {
      logger.error({ err }, "prebuild staleness cron failed");
    }
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

// Close the SSH listener on shutdown so a redeploy releases the port promptly.
if (sshGateway) {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      void sshGateway.close().finally(() => process.exit(0));
    });
  }
}

export type App = typeof app;
