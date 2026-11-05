/**
 * Toolbox refresh (docs/toolbox-versions.md §10): the "spawn a sandbox, run
 * `pi update --all`, save the toolbox, pin it" loop, run by the server. A
 * refresh starts from the toolbox's current deliverable (the pinned version,
 * else the recipe build), runs its `refresh` commands in a throwaway pod,
 * and saves the toolbox's `paths[]` as a new version that is pinned straight
 * away. Saved files identical to the current version produce no version.
 *
 * This is the api/ seam: it is the one place that sees the runtime (pod,
 * artifact), control (toolbox, versions, pin) and the jobs feed together.
 * Triggers: `POST /api/toolboxes/:id/refresh`, MCP `manage_toolbox`
 * `action=refresh`, and the per-toolbox schedule (`runDueToolboxRefreshes`,
 * ticked from index.ts).
 */
import {
  type ToolboxConfig,
  type ToolboxRefreshStatus,
  type ToolboxRefreshTrigger,
  toolboxArtifactName,
} from "@atelier/spec";
import { recipeFingerprint } from "../control/index.ts";
import type { JobRecord } from "../runtime/index.ts";
import { ValidationError } from "../shared/errors.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import type { ServerContainer } from "./container.ts";

const log = createChildLogger("toolbox-refresh");

const JOB_KIND = "toolbox-refresh";
/** Version descriptions share the capture flow's 200-char budget. */
const MAX_DESCRIPTION = 200;
/** Keep a failure readable in a list view. */
const MAX_ERROR = 500;

export interface ToolboxRefreshOptions {
  trigger: ToolboxRefreshTrigger;
  /** Who started a manual refresh (absent for the schedule). */
  userId?: string;
}

export type ToolboxRefreshOutcome =
  | {
      outcome: "updated";
      versionId: string;
      label: number;
      ref: string;
      /** False when someone moved the pin while the refresh ran: their
       * choice is kept and the new version is only saved. */
      pinned: boolean;
    }
  | { outcome: "unchanged"; versionId?: string };

/** Throw a `ValidationError` unless the toolbox can be refreshed. */
export function assertRefreshable(tb: ToolboxConfig): void {
  if (tb.refresh.length === 0) {
    throw new ValidationError(
      "toolbox has no update commands to run (set `refresh`)",
    );
  }
  if (tb.paths.length === 0) {
    throw new ValidationError("toolbox has no paths to capture");
  }
}

/** The refresh job running or queued for this toolbox, if any. */
export function activeRefreshJob(
  container: ServerContainer,
  toolboxId: string,
): JobRecord | undefined {
  return container.jobs.findActive(
    (job) => job.kind === JOB_KIND && job.metadata?.toolboxId === toolboxId,
  );
}

/**
 * Start a refresh as a pooled job (it boots a pod, like a toolset build).
 * One per toolbox at a time: when one is already running or queued, that
 * job is returned with `started: false` instead of starting another.
 */
export function startToolboxRefresh(
  container: ServerContainer,
  toolboxId: string,
  options: ToolboxRefreshOptions,
): { job: JobRecord; started: boolean } {
  const tb = container.control.toolboxService.get(toolboxId);
  assertRefreshable(tb);
  const inflight = activeRefreshJob(container, tb.id);
  if (inflight) return { job: inflight, started: false };
  // The body can start before `dispatch` returns; it reads the id lazily.
  let jobId: string | undefined;
  const job = container.jobs.dispatch(
    {
      kind: JOB_KIND,
      target: tb.slug,
      metadata: { toolboxId: tb.id, trigger: options.trigger },
    },
    (signal, jobLog) =>
      runToolboxRefresh(container, tb.id, options, {
        signal,
        onLog: jobLog,
        jobId: () => jobId,
      }),
  );
  jobId = job.id;
  return { job, started: true };
}

/** The artifact a refresh starts from: the pinned version, else the recipe
 * build (built now if needed, and recorded as a `built` version). */
async function currentDeliverable(
  container: ServerContainer,
  tb: ToolboxConfig,
  onLog?: (chunk: string) => void,
): Promise<{ ref: string; versionId?: string }> {
  const { control, runtime } = container;
  const activeId = control.toolboxService.getActiveVersionId(tb.id);
  const active = activeId
    ? control.toolboxVersionService.find(activeId)
    : undefined;
  if (active) return { ref: active.ref, versionId: active.id };
  onLog?.("No pinned version: starting from the recipe build.");
  const { ref } = await runtime.buildToolset(
    {
      name: toolboxArtifactName(tb),
      source: tb.source,
      build: tb.build,
      paths: tb.paths,
    },
    undefined,
    onLog,
  );
  await container.toolboxOps.recordBuiltVersionLazily(tb, ref);
  const built = control.toolboxVersionService.findByRef(tb.id, ref);
  return { ref, ...(built ? { versionId: built.id } : {}) };
}

function describeRefresh(
  steps: string[],
  trigger: ToolboxRefreshTrigger,
): string {
  const text = `${trigger === "schedule" ? "Scheduled refresh" : "Refresh"}: ${steps.join(" && ")}`;
  return text.length <= MAX_DESCRIPTION
    ? text
    : `${text.slice(0, MAX_DESCRIPTION - 3)}...`;
}

function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.length <= MAX_ERROR
    ? message
    : `${message.slice(0, MAX_ERROR - 3)}...`;
}

/**
 * One refresh, start to finish (the job body; callable directly in tests).
 * Records the outcome on the toolbox (`lastRefresh`) whatever happens, and
 * re-throws a failure so the job fails with it.
 */
export async function runToolboxRefresh(
  container: ServerContainer,
  toolboxId: string,
  options: ToolboxRefreshOptions,
  run: {
    signal?: AbortSignal;
    onLog?: (chunk: string) => void;
    jobId?: () => string | undefined;
  } = {},
): Promise<ToolboxRefreshOutcome> {
  const { control, runtime } = container;
  const { signal, onLog } = run;
  const tb = control.toolboxService.get(toolboxId);
  const record = (
    status: Omit<ToolboxRefreshStatus, "at" | "trigger" | "jobId">,
  ) => {
    const jobId = run.jobId?.();
    control.toolboxService.recordRefresh(tb.id, {
      at: new Date().toISOString(),
      trigger: options.trigger,
      ...status,
      ...(jobId ? { jobId } : {}),
    });
  };

  try {
    assertRefreshable(tb);
    const pinAtStart = control.toolboxService.getActiveVersionId(tb.id);
    const base = await currentDeliverable(container, tb, onLog);
    const result = await runtime.refreshToolset(
      {
        name: toolboxArtifactName(tb),
        ...(tb.source ? { source: tb.source } : {}),
        base: { ref: base.ref },
        steps: tb.refresh,
        paths: tb.paths,
      },
      signal,
      onLog,
    );

    if (!result.changed) {
      record({
        outcome: "unchanged",
        ...(base.versionId ? { versionId: base.versionId } : {}),
      });
      return {
        outcome: "unchanged",
        ...(base.versionId ? { versionId: base.versionId } : {}),
      };
    }

    const current = control.toolboxService.find(tb.id);
    if (!current) {
      throw new Error("the toolbox was deleted while it was refreshing");
    }
    // A toolbox's pin reaches every member's sandbox, which the org
    // publish-before-pin guard requires to be a published artifact. A
    // refresh builds on the version already shared there, so its output is
    // shared the same way.
    runtime.publishToolset(result.ref);
    const sourceImage = await runtime
      .resolveSourceImage(current.source ?? { image: runtime.defaultImage() })
      .catch(() => undefined);
    const version = control.toolboxVersionService.create(tb.id, {
      ref: result.ref,
      description: describeRefresh(tb.refresh, options.trigger),
      provenance: {
        kind: "refreshed",
        from: base.ref,
        ...(base.versionId ? { fromVersionId: base.versionId } : {}),
        steps: tb.refresh,
        trigger: options.trigger,
        ...(options.userId ? { by: options.userId } : {}),
        ...(sourceImage ? { sourceImage } : {}),
      },
      recipeFingerprint: recipeFingerprint(current),
    });
    // Pin, unless the pin moved while the refresh ran (someone pinned or
    // unpinned by hand): that later, explicit choice wins.
    const pinned =
      control.toolboxService.getActiveVersionId(tb.id) === pinAtStart;
    if (pinned) control.toolboxService.setActiveVersionId(tb.id, version.id);
    container.toolboxOps.pruneVersions(tb.id);
    record({ outcome: "updated", versionId: version.id, pinned });
    log.info(
      {
        toolboxId: tb.id,
        label: version.label,
        ref: version.ref,
        pinned,
        trigger: options.trigger,
      },
      "toolbox refreshed",
    );
    onLog?.(
      pinned
        ? `Saved and pinned v${version.label}.`
        : `Saved v${version.label}; the pin moved during the refresh, so it was left as is.`,
    );
    return {
      outcome: "updated",
      versionId: version.id,
      label: version.label,
      ref: version.ref,
      pinned,
    };
  } catch (err) {
    record({ outcome: "failed", error: errorText(err) });
    log.warn(
      { toolboxId: tb.id, trigger: options.trigger, err },
      "toolbox refresh failed",
    );
    throw err;
  }
}

/**
 * The scheduler tick: start a refresh for every toolbox whose schedule is
 * due. Each one's next run is planned BEFORE it starts, so a refresh that
 * fails waits for its next slot instead of retrying every tick, and a
 * server that was down runs a missed slot once, not once per missed slot.
 * Returns how many refreshes it started.
 */
export function runDueToolboxRefreshes(
  container: ServerContainer,
  now: Date = new Date(),
): number {
  const { toolboxService } = container.control;
  let started = 0;
  for (const tb of toolboxService.listDueForRefresh(now)) {
    toolboxService.advanceRefreshSchedule(tb.id, now);
    try {
      if (
        startToolboxRefresh(container, tb.id, { trigger: "schedule" }).started
      )
        started++;
    } catch (err) {
      // Not startable (no paths, toolbox gone): say so on the toolbox.
      toolboxService.recordRefresh(tb.id, {
        at: now.toISOString(),
        trigger: "schedule",
        outcome: "failed",
        error: errorText(err),
      });
      log.warn({ toolboxId: tb.id, err }, "scheduled refresh not started");
    }
  }
  return started;
}
