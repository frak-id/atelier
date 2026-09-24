/**
 * `/api/launchpad/*` — the non-technical surface (docs/proposals/launchpad.md).
 *
 * Starters are control CRUD. Launching one crosses the seam: the server reads
 * the stored recipe (a consumer never supplies a spec), runs it through the
 * exact `POST /v1/sandboxes` path (`createSandboxForUser`: enrichment,
 * toolboxes, org policy, git attribution), then starts the services the
 * author declared. A workspace's phase is derived here, the only layer that
 * sees both the control row and the runtime record.
 */
import {
  autostartProcesses,
  type LaunchpadService,
  LaunchRequestSchema,
  type ResolvedService,
  resolveWorkspaceServices,
  type SandboxSummary,
  type Starter,
  StarterInputSchema,
  StarterPatchSchema,
  starterLaunchRequest,
  WorkspacePatchSchema,
  type WorkspacePhase,
  type WorkspaceSnapshot,
  workspacePhase,
} from "@atelier/spec";
import { Elysia, t } from "elysia";
import type { AuthUser, WorkspaceRecord } from "../control/index.ts";
import type { JobRecord } from "../runtime/index.ts";
import { ConflictError, NotFoundError } from "../shared/errors.ts";
import { safeNanoid } from "../shared/lib/id.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import { createAuthPlugin } from "./auth.plugin.ts";
import type { ServerContainer } from "./container.ts";
import {
  readableOwners,
  requireOwnerReadAccess,
  requireToolboxOwnerAccess,
  resolveOwner,
} from "./toolbox-access.ts";
import { createSandboxForUser, withFreshCredentials } from "./v1.routes.ts";

const log = createChildLogger("launchpad-routes");

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

function snapshotOf(starter: Starter): WorkspaceSnapshot {
  return {
    starterTitle: starter.title,
    ...(starter.icon ? { icon: starter.icon } : {}),
    ...(starter.guide ? { guide: starter.guide } : {}),
    services: starter.services,
  };
}

export function createLaunchpadRoutes(container: ServerContainer) {
  const { control, runtime, jobs } = container;
  const authPlugin = createAuthPlugin(control);

  function findJob(jobId: string | undefined): JobRecord | undefined {
    if (!jobId) return undefined;
    try {
      return jobs.get(jobId);
    } catch {
      // Pruned by the retention sweep: the record alone decides.
      return undefined;
    }
  }

  function findSandbox(id: string): SandboxSummary | undefined {
    return runtime.list().find((s) => s.id === id);
  }

  /**
   * The view for a row, or `undefined` when the sandbox is gone (destroyed
   * from the developer console or the CLI). A gone row is pruned right away:
   * a listing is the only place that notices, and a dead tile helps no one.
   */
  function toView(
    record: WorkspaceRecord,
    sandbox: SandboxSummary | undefined,
  ): WorkspaceView | undefined {
    const job = findJob(record.jobId);
    const phase = workspacePhase(sandbox?.status, job?.status);
    if (phase === "gone") {
      control.workspaceService.delete(record.sandboxId);
      log.info({ sandboxId: record.sandboxId }, "pruned a gone workspace");
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

  function requireView(record: WorkspaceRecord): WorkspaceView {
    const view = toView(record, findSandbox(record.sandboxId));
    // Just pruned: answer like any other missing workspace.
    if (!view) throw new NotFoundError("Workspace", record.sandboxId);
    return view;
  }

  /** Start the declared services' lazy processes. Best-effort: a service
   * that won't start must not fail a launch that otherwise succeeded — the
   * tile shows it as stopped, with a manual start. */
  async function autostart(
    sandboxId: string,
    services: LaunchpadService[],
    progress: (msg: string) => void,
  ): Promise<void> {
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

  function dispatchLaunch(
    user: AuthUser,
    sandboxId: string,
    starter: Starter,
    title: string,
  ): JobRecord {
    const request = starterLaunchRequest(starter, title);
    return jobs.dispatch(
      {
        kind: "sandbox-create",
        target: title,
        metadata: { sandboxId, launchpadStarter: starter.id },
        // Latency-sensitive: never queue behind a build.
        unpooled: true,
      },
      async (_signal, progress) => {
        const created = await createSandboxForUser(
          container,
          user,
          request,
          sandboxId,
          progress,
        );
        await autostart(sandboxId, starter.services, progress);
        return created;
      },
    );
  }

  /** Resume in the background (a wake-up can take a while; the record stays
   * `paused` until it's back, so the job drives the phase meanwhile). */
  function dispatchWake(record: WorkspaceRecord): JobRecord {
    const job = jobs.dispatch(
      {
        kind: "sandbox-resume",
        target: record.sandboxId,
        metadata: { sandboxId: record.sandboxId },
        unpooled: true,
      },
      async (_signal, progress) => {
        const resumed = await runtime.resume(
          record.sandboxId,
          await withFreshCredentials(container, record.sandboxId),
        );
        await autostart(record.sandboxId, record.snapshot.services, progress);
        return resumed;
      },
    );
    control.workspaceService.setJob(record.sandboxId, job.id);
    return job;
  }

  const starterRoutes = new Elysia({ prefix: "/starters" })
    .use(authPlugin)
    // ── authoring (owner-scoped, like toolboxes) ──────────────────────────
    .get(
      "/",
      ({ user, query }) =>
        control.starterService.list(
          resolveOwner(control, user.id, query.owner, false),
        ),
      { query: t.Object({ owner: t.Optional(t.String()) }) },
    )
    .post(
      "/",
      ({ user, query, body }) =>
        control.starterService.create(
          resolveOwner(control, user.id, query.owner, true),
          body,
        ),
      {
        query: t.Object({ owner: t.Optional(t.String()) }),
        body: StarterInputSchema,
      },
    )
    .patch(
      "/:id",
      ({ user, params, body }) => {
        const starter = control.starterService.get(params.id);
        requireToolboxOwnerAccess(control, starter, user.id);
        return control.starterService.update(params.id, body);
      },
      { body: StarterPatchSchema },
    )
    .delete("/:id", ({ user, params, set }) => {
      const starter = control.starterService.get(params.id);
      requireToolboxOwnerAccess(control, starter, user.id);
      control.starterService.delete(params.id);
      set.status = 204;
    })
    // ── launching ─────────────────────────────────────────────────────────
    .post(
      "/:id/launch",
      ({ user, params, body, set }) => {
        const starter = control.starterService.get(params.id);
        // A published starter is launchable by anyone who can see it; a
        // draft only by its authors (a test launch before publishing).
        if (starter.published) {
          requireOwnerReadAccess(control, starter, user.id);
        } else {
          requireToolboxOwnerAccess(control, starter, user.id);
        }
        const title = body.title?.trim() || starter.title;
        // Pre-allocated, like `POST /v1/sandboxes`: the row (and the page the
        // console navigates to) exists before the runtime record lands.
        const sandboxId = safeNanoid();
        const job = dispatchLaunch(user, sandboxId, starter, title);
        const record = control.workspaceService.create({
          sandboxId,
          userId: user.id,
          starterId: starter.id,
          jobId: job.id,
          title,
          description: body.description,
          snapshot: snapshotOf(starter),
        });
        set.status = 202;
        return requireView(record);
      },
      { body: LaunchRequestSchema },
    );

  const workspaceRoutes = new Elysia({ prefix: "/workspaces" })
    .use(authPlugin)
    .get("/", ({ user }) => {
      const sandboxes = new Map(runtime.list().map((s) => [s.id, s]));
      return control.workspaceService
        .listByUser(user.id)
        .map((record) => toView(record, sandboxes.get(record.sandboxId)))
        .filter((view): view is WorkspaceView => view !== undefined);
    })
    .get("/:id", async ({ user, params }): Promise<WorkspaceDetail> => {
      const record = control.workspaceService.getOwned(params.id, user.id);
      const sandbox = findSandbox(record.sandboxId);
      const view = toView(record, sandbox);
      if (!view) throw new NotFoundError("Workspace", params.id);
      // Live urls (with readiness) only exist for a booted sandbox; asleep,
      // a port tile has no url and a link tile still works.
      const urls =
        sandbox?.status === "running"
          ? (await runtime.get(record.sandboxId)).urls
          : [];
      return {
        ...view,
        ...(record.snapshot.guide ? { guide: record.snapshot.guide } : {}),
        services: resolveWorkspaceServices(
          record.snapshot.services,
          urls,
          record.sandboxId,
        ),
      };
    })
    .patch(
      "/:id",
      ({ user, params, body }) =>
        requireView(control.workspaceService.update(params.id, user.id, body)),
      { body: WorkspacePatchSchema },
    )
    .post("/:id/sleep", async ({ user, params }) => {
      const record = control.workspaceService.getOwned(params.id, user.id);
      if (requireView(record).phase !== "ready") {
        throw new ConflictError("Only a ready workspace can go to sleep");
      }
      await jobs.track({ kind: "sandbox-pause", target: params.id }, () =>
        runtime.pause(params.id),
      );
      return requireView(record);
    })
    .post("/:id/wake", ({ user, params, set }) => {
      const record = control.workspaceService.getOwned(params.id, user.id);
      if (requireView(record).phase !== "sleeping") {
        throw new ConflictError("Only a sleeping workspace can be woken up");
      }
      dispatchWake(record);
      set.status = 202;
      return requireView(control.workspaceService.getOwned(params.id, user.id));
    })
    .post("/:id/retry", ({ user, params, set }) => {
      const record = control.workspaceService.getOwned(params.id, user.id);
      if (requireView(record).phase !== "failed") {
        throw new ConflictError("Only a failed workspace can be retried");
      }
      if (findSandbox(record.sandboxId)) {
        // The record exists (in `error`): resume is the runtime's recovery.
        dispatchWake(record);
      } else {
        // The launch failed before the record landed: launch again, same id,
        // from the starter as it is now.
        if (!record.starterId) {
          throw new ConflictError("This workspace can't be restarted");
        }
        const starter = control.starterService.get(record.starterId);
        requireOwnerReadAccess(control, starter, user.id);
        const job = dispatchLaunch(
          user,
          record.sandboxId,
          starter,
          record.title,
        );
        control.workspaceService.setJob(
          record.sandboxId,
          job.id,
          snapshotOf(starter),
        );
      }
      set.status = 202;
      return requireView(control.workspaceService.getOwned(params.id, user.id));
    })
    .delete("/:id", async ({ user, params, set }) => {
      const record = control.workspaceService.getOwned(params.id, user.id);
      const sandbox = findSandbox(record.sandboxId);
      const phase = workspacePhase(
        sandbox?.status,
        findJob(record.jobId)?.status,
      );
      // A boot in flight can't be cancelled cleanly (the record may land
      // after we look): wait for it to settle, then delete.
      if (phase === "preparing" || phase === "starting") {
        throw new ConflictError(
          "This workspace is still starting — delete it once it's ready",
        );
      }
      if (sandbox) {
        await jobs.track({ kind: "sandbox-destroy", target: params.id }, () =>
          runtime.destroy(params.id),
        );
      }
      control.workspaceService.delete(record.sandboxId);
      set.status = 204;
    });

  return new Elysia({ prefix: "/api/launchpad" })
    .use(authPlugin)
    .get("/catalog", ({ user }): CatalogStarter[] => {
      const orgNames = new Map(
        control.organizationService
          .getByUserId(user.id)
          .map((org) => [org.id, org.name]),
      );
      return control.starterService
        .listPublished(readableOwners(control, user.id))
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
    })
    .use(starterRoutes)
    .use(workspaceRoutes);
}
