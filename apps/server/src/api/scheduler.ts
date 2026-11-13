/**
 * Every recurring job, registered in one place. Scheduling uses Bun's
 * in-process `Bun.cron`: the next fire is computed only once the handler (and
 * its returned Promise) settles, so runs never overlap. A throw/rejection
 * escaping a handler surfaces as an uncaught error (which exits the process),
 * so every handler body stays fully try/catch-guarded (`guarded`).
 */
import { prebuildJobTarget } from "@atelier/spec";
import { logger, rotateLogFile } from "../shared/lib/logger.ts";
import type { ServerContainer } from "./container.ts";
import { runDueToolboxRefreshes } from "./toolbox-refresh.ts";

/** The `jobs` table is append-only (one row per long op forever), so keep a
 * bounded history: terminal rows older than a week are pruned. */
const JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function guarded(
  name: string,
  fn: () => void | Promise<void>,
): () => Promise<void> {
  return async () => {
    try {
      await fn();
    } catch (err) {
      logger.error({ err }, `${name} failed`);
    }
  };
}

/**
 * Recompute each stored prebuild's content key against current remote HEADs
 * + base image digest and dispatch a rebuild job for every one that moved
 * (pooled by `jobs.concurrency`, visible in the feed, cancellable); then
 * enforce the retention window. Gated on the `prebuild.gitTracking` config
 * (read every tick, so a live toggle takes effect without a restart). A
 * failed rebuild leaves the previous snapshot in place: the next tick tries
 * again.
 */
export async function dispatchStalePrebuilds(
  container: ServerContainer,
): Promise<number> {
  const { runtime, jobs, control } = container;
  const { serverConfigService, gitCredentials } = control;
  if (!serverConfigService.get("prebuild.gitTracking")) return 0;
  // Private repos are reached with the prebuild creator's own token (a
  // service account's own credential, never a person's). This token serves
  // the staleness probe only: the queued job resolves its own, as an App
  // token can expire while a job waits for the pool.
  const stale = await runtime.prebuilds.findStale((userId) =>
    gitCredentials.token(userId),
  );
  let dispatched = 0;
  for (const rebuild of stale) {
    // A previous tick's rebuild of the same content is still queued/running.
    if (
      jobs.findActive(
        (job) => job.kind === "prebuild" && job.metadata?.hash === rebuild.hash,
      )
    ) {
      continue;
    }
    jobs.dispatch(
      {
        kind: "prebuild",
        target: prebuildJobTarget(rebuild.spec),
        metadata: { ...rebuild.spec.metadata, hash: rebuild.hash },
      },
      async (signal, log) => {
        log(`Upstream moved for ${rebuild.ref}; rebuilding`);
        const githubToken = rebuild.createdBy
          ? await gitCredentials.token(rebuild.createdBy)
          : undefined;
        return runtime.prebuild(rebuild.spec, {
          githubToken,
          createdBy: rebuild.createdBy,
          signal,
          onLog: log,
        });
      },
    );
    dispatched++;
  }
  await runtime.pruneUnusedPrebuilds(
    serverConfigService.get("prebuild.pruneKeep"),
  );
  return dispatched;
}

export function startScheduler(container: ServerContainer): void {
  // Retention runs once at startup too, so a long-down server doesn't wait
  // an hour.
  container.jobs.pruneTerminal(JOB_RETENTION_MS);
  Bun.cron(
    "23 * * * *",
    guarded("jobs retention prune", () => {
      container.jobs.pruneTerminal(JOB_RETENTION_MS);
    }),
  );

  // Idle auto-pause (docs/idle-autopause.md): poll every
  // running sandbox's activity, and pause the idle ones when the operator's
  // `sandbox.idle.mode` is `enforce` (read every tick, like the rest of the
  // rule). Every mode: the mode key decides what a tick does.
  Bun.cron(
    "* * * * *",
    guarded("idle reaper tick", () => container.idle.tick()),
  );

  // A sandbox whose compute restarted without the runtime (a node or host
  // reboot) comes back with an agent that has no config: push it again and
  // restart the processes. Every minute, so a reboot heals within one.
  Bun.cron(
    "* * * * *",
    guarded("restarted sandbox recovery", async () => {
      await container.runtime.recoverRestarted();
    }),
  );

  // Scheduled toolbox refreshes (docs/toolbox-versions.md section 10): start
  // a refresh job for every toolbox whose cron schedule is due. The tick only
  // dispatches (the jobs pool runs the pods), so it stays short.
  Bun.cron(
    "* * * * *",
    guarded("toolbox refresh scheduler tick", () => {
      runDueToolboxRefreshes(container);
    }),
  );

  Bun.cron(
    "*/30 * * * *",
    guarded("prebuild staleness check", async () => {
      await dispatchStalePrebuilds(container);
    }),
  );

  // Config-declared service accounts. The env vars and the config file are
  // read at process start, so a changed key/token env var or an edited
  // `serviceAccounts` list applies on restart; a pass picks up an org
  // created since, and a changed `privateKeyFile`.
  Bun.cron(
    "*/5 * * * *",
    guarded("service account reconcile", () =>
      container.control.reconcileServiceAccounts(),
    ),
  );

  // Running sandboxes: an App token lasts an hour and a person's token
  // changes at each login, so keep their credential file current.
  Bun.cron(
    "*/5 * * * *",
    guarded("git credential refresh", () =>
      container.gitCredentialRefresh.tick(),
    ),
  );

  // The server log file (production) rotates by size.
  Bun.cron(
    "*/10 * * * *",
    guarded("log rotation", () => rotateLogFile()),
  );
}
