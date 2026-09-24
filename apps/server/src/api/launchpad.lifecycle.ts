/**
 * The Launchpad's workspace lifecycle (docs/proposals/launchpad.md): the seam
 * logic behind `/api/launchpad`, the only layer that sees both the control
 * rows (starters, workspaces) and the runtime records.
 *
 * Launching reads the stored recipe (a consumer never supplies a spec) and
 * runs it through the exact `POST /v1/sandboxes` path (`createSandbox`:
 * enrichment, toolboxes, org policy, git attribution), then starts the
 * services the author declared. A workspace's phase is derived from the
 * runtime record + its latest lifecycle job.
 *
 * Runtime, jobs and the two `/v1` seam functions are injected so the whole
 * lifecycle is testable against a fake runtime (launchpad.lifecycle.test.ts).
 */
import {
  autostartProcesses,
  type CreateSandboxRequest,
  type LaunchpadService,
  type LaunchRequest,
  type ResolvedService,
  type ResumeRequest,
  resolveWorkspaceServices,
  type SandboxSummary,
  type Starter,
  starterLaunchRequest,
  type WorkspacePatch,
  type WorkspacePhase,
  type WorkspaceSnapshot,
  workspacePhase,
} from "@atelier/spec";
import type {
  AuthUser,
  ControlContainer,
  WorkspaceRecord,
} from "../control/index.ts";
import type {
  JobRecord,
  JobService,
  RuntimeService,
} from "../runtime/index.ts";
import { ConflictError, NotFoundError } from "../shared/errors.ts";
import { safeNanoid } from "../shared/lib/id.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import {
  readableOwners,
  requireOwnerReadAccess,
  requireToolboxOwnerAccess,
} from "./toolbox-access.ts";

const log = createChildLogger("launchpad");

/** A workspace as the Launchpad renders it. */
export interface WorkspaceView {
  id: string;
  title: string;
  description: string;
  starterId?: string;
  starterTitle: string;
  icon?: string;
  phase: Exclude<WorkspacePhase, "gone">;
  /** The latest launch/wake-up failure, when `phase` is `failed`. */
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceDetail extends WorkspaceView {
  guide?: string;
  services: ResolvedService[];
}

/** A starter as the Launchpad catalog shows it: presentation only, never
 * the recipe. */
export interface CatalogStarter {
  id: string;
  title: string;
  description: string;
  icon?: string;
  /** Who curated it: the org's name, or "Personal". */
  ownerLabel: string;
  services: { label: string; icon?: string }[];
}

export interface LaunchpadLifecycleDeps {
  control: ControlContainer;
  runtime: Pick<
    RuntimeService,
    "list" | "get" | "pause" | "resume" | "destroy" | "processAction"
  >;
  jobs: Pick<JobService, "get" | "dispatch" | "track">;
  /** `POST /v1/sandboxes`'s create path (`createSandboxForUser`). */
  createSandbox: (
    user: AuthUser,
    request: CreateSandboxRequest,
    sandboxId: string,
    progress: (msg: string) => void,
  ) => Promise<unknown>;
  /** The resume body with the owner's git credentials refreshed
   * (`withFreshCredentials`). */
  resumeBody: (sandboxId: string) => Promise<ResumeRequest>;
}

function snapshotOf(starter: Starter): WorkspaceSnapshot {
  return {
    starterTitle: starter.title,
    ...(starter.icon ? { icon: starter.icon } : {}),
    ...(starter.guide ? { guide: starter.guide } : {}),
    services: starter.services,
  };
}

/**
 * Who may launch a starter: anyone who can see a published one; only its
 * authors for a draft (a test launch before publishing). Checked on every
 * launch, including a retry — a starter unpublished since the first attempt
 * is authors-only again.
 */
function requireLaunchAccess(
  control: ControlContainer,
  starter: Starter,
  userId: string,
): void {
  if (starter.published) {
    requireOwnerReadAccess(control, starter, userId);
  } else {
    requireToolboxOwnerAccess(control, starter, userId);
  }
}

export class LaunchpadLifecycle {
  constructor(private readonly deps: LaunchpadLifecycleDeps) {}

  // ── catalog ───────────────────────────────────────────────────────────────

  /** Published starters from the caller and their orgs, presentation only. */
  catalog(userId: string): CatalogStarter[] {
    const { control } = this.deps;
    const orgNames = new Map(
      control.organizationService
        .getByUserId(userId)
        .map((org) => [org.id, org.name]),
    );
    return control.starterService
      .listPublished(readableOwners(control, userId))
      .map((starter) => ({
        id: starter.id,
        title: starter.title,
        description: starter.description,
        ...(starter.icon ? { icon: starter.icon } : {}),
        ownerLabel:
          starter.ownerType === "org"
            ? (orgNames.get(starter.ownerId) ?? "Your team")
            : "Personal",
        services: starter.services.map((s) => ({
          label: s.label,
          ...(s.icon ? { icon: s.icon } : {}),
        })),
      }));
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  list(userId: string): WorkspaceView[] {
    const sandboxes = new Map(this.deps.runtime.list().map((s) => [s.id, s]));
    return this.deps.control.workspaceService
      .listByUser(userId)
      .map((record) => this.toView(record, sandboxes.get(record.sandboxId)))
      .filter((view): view is WorkspaceView => view !== undefined);
  }

  async detail(id: string, userId: string): Promise<WorkspaceDetail> {
    const record = this.deps.control.workspaceService.getOwned(id, userId);
    const sandbox = this.findSandbox(id);
    const view = this.requireView(record, sandbox);
    // Live urls (with readiness) only exist for a booted sandbox; asleep, a
    // port tile has no url and a link tile still works.
    const urls =
      sandbox?.status === "running"
        ? (await this.deps.runtime.get(id)).urls
        : [];
    return {
      ...view,
      ...(record.snapshot.guide ? { guide: record.snapshot.guide } : {}),
      services: resolveWorkspaceServices(record.snapshot.services, urls, id),
    };
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  launch(
    user: AuthUser,
    starterId: string,
    body: LaunchRequest,
  ): WorkspaceView {
    const { control } = this.deps;
    const starter = control.starterService.get(starterId);
    requireLaunchAccess(control, starter, user.id);
    const title = body.title?.trim() || starter.title;
    // Pre-allocated, like `POST /v1/sandboxes`: the row (and the page the
    // console navigates to) exists before the runtime record lands.
    const sandboxId = safeNanoid();
    const job = this.dispatchLaunch(user, sandboxId, starter, title);
    const record = control.workspaceService.create({
      sandboxId,
      userId: user.id,
      starterId: starter.id,
      jobId: job.id,
      title,
      ...(body.description !== undefined
        ? { description: body.description }
        : {}),
      snapshot: snapshotOf(starter),
    });
    return this.requireView(record);
  }

  rename(id: string, userId: string, patch: WorkspacePatch): WorkspaceView {
    return this.requireView(
      this.deps.control.workspaceService.update(id, userId, patch),
    );
  }

  async sleep(id: string, userId: string): Promise<WorkspaceView> {
    const { control, jobs, runtime } = this.deps;
    const record = control.workspaceService.getOwned(id, userId);
    if (this.requireView(record).phase !== "ready") {
      throw new ConflictError("Only a ready workspace can go to sleep");
    }
    await jobs.track({ kind: "sandbox-pause", target: id }, () =>
      runtime.pause(id),
    );
    // Put away just now: float it to the top of "jump back in", like a wake.
    control.workspaceService.touch(id);
    return this.requireView(control.workspaceService.getOwned(id, userId));
  }

  wake(id: string, userId: string): WorkspaceView {
    const { control } = this.deps;
    const record = control.workspaceService.getOwned(id, userId);
    if (this.requireView(record).phase !== "sleeping") {
      throw new ConflictError("Only a sleeping workspace can be woken up");
    }
    this.dispatchWake(record);
    return this.requireView(control.workspaceService.getOwned(id, userId));
  }

  retry(user: AuthUser, id: string): WorkspaceView {
    const { control } = this.deps;
    const record = control.workspaceService.getOwned(id, user.id);
    if (this.requireView(record).phase !== "failed") {
      throw new ConflictError("Only a failed workspace can be retried");
    }
    if (this.findSandbox(id)) {
      // The record exists (in `error`): resume is the runtime's recovery.
      this.dispatchWake(record);
    } else {
      // The launch failed before the record landed: launch again, same id,
      // from the starter as it is now.
      const starter = record.starterId
        ? control.starterService.find(record.starterId)
        : undefined;
      if (!starter) {
        throw new ConflictError(
          "This workspace can't be restarted: its starter no longer exists",
        );
      }
      requireLaunchAccess(control, starter, user.id);
      const job = this.dispatchLaunch(user, id, starter, record.title);
      control.workspaceService.setJob(id, job.id, snapshotOf(starter));
    }
    return this.requireView(control.workspaceService.getOwned(id, user.id));
  }

  async delete(id: string, userId: string): Promise<void> {
    const { control, jobs, runtime } = this.deps;
    const record = control.workspaceService.getOwned(id, userId);
    const sandbox = this.findSandbox(id);
    const phase = workspacePhase(
      sandbox?.status,
      this.findJob(record.jobId)?.status,
    );
    // A boot in flight can't be cancelled cleanly (the record may land after
    // we look): wait for it to settle, then delete.
    if (phase === "preparing" || phase === "starting") {
      throw new ConflictError(
        "This workspace is still starting — delete it once it's ready",
      );
    }
    if (sandbox) {
      await jobs.track({ kind: "sandbox-destroy", target: id }, () =>
        runtime.destroy(id).catch((err: unknown) => {
          // Destroyed elsewhere since we looked: that's the goal state.
          if (!(err instanceof NotFoundError)) throw err;
        }),
      );
    }
    control.workspaceService.delete(id);
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private findJob(jobId: string | undefined): JobRecord | undefined {
    if (!jobId) return undefined;
    try {
      return this.deps.jobs.get(jobId);
    } catch {
      // Pruned by the retention sweep: the record alone decides.
      return undefined;
    }
  }

  private findSandbox(id: string): SandboxSummary | undefined {
    return this.deps.runtime.list().find((s) => s.id === id);
  }

  /**
   * The view for a row, or `undefined` when the sandbox is gone (destroyed
   * from the developer console or the CLI). A gone row is pruned right away:
   * a read is the only place that notices, and a dead tile helps no one.
   */
  private toView(
    record: WorkspaceRecord,
    sandbox: SandboxSummary | undefined,
  ): WorkspaceView | undefined {
    const job = this.findJob(record.jobId);
    const phase = workspacePhase(sandbox?.status, job?.status);
    if (phase === "gone") {
      this.deps.control.workspaceService.delete(record.sandboxId);
      return undefined;
    }
    const error =
      phase === "failed"
        ? (job?.error ?? "The workspace stopped unexpectedly.")
        : undefined;
    return {
      id: record.sandboxId,
      title: record.title,
      description: record.description,
      ...(record.starterId ? { starterId: record.starterId } : {}),
      starterTitle: record.snapshot.starterTitle,
      ...(record.snapshot.icon ? { icon: record.snapshot.icon } : {}),
      phase,
      ...(error ? { error } : {}),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private requireView(
    record: WorkspaceRecord,
    sandbox = this.findSandbox(record.sandboxId),
  ): WorkspaceView {
    const view = this.toView(record, sandbox);
    // Just pruned: answer like any other missing workspace.
    if (!view) throw new NotFoundError("Workspace", record.sandboxId);
    return view;
  }

  /** Start the declared services' lazy processes. Best-effort: a service
   * that won't start must not fail a launch that otherwise succeeded — the
   * tile shows it as stopped, with a manual start. */
  private async autostart(
    sandboxId: string,
    services: LaunchpadService[],
    progress: (msg: string) => void,
  ): Promise<void> {
    const { runtime } = this.deps;
    const state = await runtime.get(sandboxId);
    const names = autostartProcesses(services, state.urls);
    if (names.length === 0) return;
    progress(`starting ${names.join(", ")}…`);
    await Promise.all(
      names.map((name) =>
        runtime
          .processAction(sandboxId, name, "start")
          .catch((err) =>
            log.warn({ sandboxId, name, err }, "autostart failed"),
          ),
      ),
    );
  }

  private dispatchLaunch(
    user: AuthUser,
    sandboxId: string,
    starter: Starter,
    title: string,
  ): JobRecord {
    const request = starterLaunchRequest(starter, title);
    return this.deps.jobs.dispatch(
      {
        kind: "sandbox-create",
        target: title,
        metadata: { sandboxId, launchpadStarter: starter.id },
        // Latency-sensitive: never queue behind a build.
        unpooled: true,
      },
      async (_signal, progress) => {
        const created = await this.deps.createSandbox(
          user,
          request,
          sandboxId,
          progress,
        );
        await this.autostart(sandboxId, starter.services, progress);
        return created;
      },
    );
  }

  /** Resume in the background (a wake-up can take a while; the record stays
   * `paused` until it's back, so the job drives the phase meanwhile). */
  private dispatchWake(record: WorkspaceRecord): JobRecord {
    const { sandboxId } = record;
    const job = this.deps.jobs.dispatch(
      {
        kind: "sandbox-resume",
        target: sandboxId,
        metadata: { sandboxId },
        unpooled: true,
      },
      async (_signal, progress) => {
        const resumed = await this.deps.runtime.resume(
          sandboxId,
          await this.deps.resumeBody(sandboxId),
        );
        await this.autostart(sandboxId, record.snapshot.services, progress);
        return resumed;
      },
    );
    this.deps.control.workspaceService.setJob(sandboxId, job.id);
    return job;
  }
}
