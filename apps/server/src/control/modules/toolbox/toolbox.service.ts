/**
 * Entity-scoped toolbox config CRUD (entities-toolbox.md §4). The api/ seam
 * (`container.ts` `resolveToolboxRefs`) turns `listEnabled()` results into
 * built `ToolsetRef`s at spawn time; this service knows nothing about
 * `runtime/` or building — pure control-plane config storage.
 *
 * A toolbox is owned by an `org` (place-scoped, mandated baseline) or a `user`
 * (identity-scoped, personal overlay). No server-side seeding: toolboxes are
 * created explicitly (console/CLI); the console offers starter templates.
 */
import type {
  ToolboxConfig,
  ToolboxConfigInput,
  ToolboxConfigPatch,
  ToolboxOwner,
  ToolboxRefreshStatus,
} from "@atelier/spec";
import { NotFoundError, ValidationError } from "../../../shared/errors.ts";
import { safeNanoid } from "../../../shared/lib/id.ts";
import { createChildLogger } from "../../../shared/lib/logger.ts";
import { nextRefreshAt, validateRefreshSchedule } from "./refresh-schedule.ts";
import type { ToolboxRepository } from "./toolbox.repository.ts";

const log = createChildLogger("toolbox-service");

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

/** When the schedule next fires, or null when nothing would run: a
 * refresh needs both a schedule and update commands. */
function scheduledNext(
  schedule: string | undefined,
  steps: string[],
  from: Date,
): string | null {
  if (!schedule || steps.length === 0) return null;
  return nextRefreshAt(schedule, from);
}

export class ToolboxService {
  constructor(private readonly repository: ToolboxRepository) {}

  list(owner: ToolboxOwner): ToolboxConfig[] {
    return this.repository.list(owner);
  }

  /** Auto-inject toolboxes, oldest-first — the spawn-injection order (R6). */
  listAutoInject(owner: ToolboxOwner): ToolboxConfig[] {
    return this.repository.listAutoInject(owner);
  }

  /** Non-throwing lookup by id. */
  find(id: string): ToolboxConfig | undefined {
    return this.repository.getById(id);
  }

  get(id: string): ToolboxConfig {
    const config = this.repository.getById(id);
    if (!config) throw new NotFoundError("ToolboxConfig", id);
    return config;
  }

  /** Lookup by owner+slug (undefined if absent) — used by the api/ seam to
   * map a `tb/…` toolset ref back to its declaring toolbox config. */
  getByOwnerAndSlug(
    owner: ToolboxOwner,
    slug: string,
  ): ToolboxConfig | undefined {
    return this.repository.getByOwnerAndSlug(owner, slug);
  }

  create(owner: ToolboxOwner, input: ToolboxConfigInput): ToolboxConfig {
    if (this.repository.getByOwnerAndSlug(owner, input.slug)) {
      throw new ValidationError(
        `A toolbox with slug '${input.slug}' already exists for this ${owner.type}`,
      );
    }
    if (input.refreshSchedule) validateRefreshSchedule(input.refreshSchedule);
    const refresh = input.refresh ?? [];
    const next = scheduledNext(input.refreshSchedule, refresh, new Date());
    const now = new Date().toISOString();
    const record: ToolboxConfig = {
      id: safeNanoid(12),
      ownerType: owner.type,
      ownerId: owner.id,
      slug: input.slug,
      description: input.description,
      source: input.source,
      build: input.build,
      paths: input.paths,
      harness: input.harness,
      processes: input.processes,
      ports: input.ports,
      autoInject: input.autoInject ?? true,
      refresh,
      ...(input.refreshSchedule
        ? { refreshSchedule: input.refreshSchedule }
        : {}),
      ...(next ? { nextRefreshAt: next } : {}),
      createdAt: now,
      updatedAt: now,
    };
    log.info(
      { ownerType: owner.type, ownerId: owner.id, slug: input.slug },
      "Toolbox config created",
    );
    try {
      return this.repository.create(record);
    } catch (err) {
      // Convert a slug race (the pre-check above is TOCTOU) into a clean 400.
      if (isUniqueConstraintError(err)) {
        throw new ValidationError(
          `A toolbox with slug '${input.slug}' already exists for this ${owner.type}`,
        );
      }
      throw err;
    }
  }

  update(id: string, patch: ToolboxConfigPatch): ToolboxConfig {
    const existing = this.get(id);
    if (patch.refreshSchedule) validateRefreshSchedule(patch.refreshSchedule);
    const updated = this.repository.update(id, {
      ...patch,
      ...this.rescheduled(existing, patch),
    });
    if (!updated) throw new NotFoundError("ToolboxConfig", id);
    return updated;
  }

  /** The `nextRefreshAt` a patch implies: a new schedule restarts the clock;
   * otherwise an already-planned run is kept, and one is planned when the
   * update commands that it lacked arrive. Absent = unchanged. */
  private rescheduled(
    existing: ToolboxConfig,
    patch: ToolboxConfigPatch,
  ): { nextRefreshAt?: string | null } {
    if (patch.refreshSchedule === undefined && patch.refresh === undefined) {
      return {};
    }
    const schedule =
      patch.refreshSchedule === undefined
        ? existing.refreshSchedule
        : (patch.refreshSchedule ?? undefined);
    const steps = patch.refresh ?? existing.refresh;
    const scheduleChanged =
      patch.refreshSchedule !== undefined &&
      (patch.refreshSchedule ?? undefined) !== existing.refreshSchedule;
    if (!scheduleChanged && existing.nextRefreshAt && steps.length > 0) {
      return {};
    }
    return { nextRefreshAt: scheduledNext(schedule, steps, new Date()) };
  }

  // ── refresh bookkeeping (docs/toolbox-versions.md §10) ───────────────────

  /** Toolboxes whose scheduled refresh is due at `now`. */
  listDueForRefresh(now: Date): ToolboxConfig[] {
    return this.repository.listDueForRefresh(now.toISOString());
  }

  /** Move a toolbox's next scheduled refresh to the first fire after
   * `from` (null when it no longer has a schedule and update commands). */
  advanceRefreshSchedule(id: string, from: Date): string | null {
    const config = this.get(id);
    const next = scheduledNext(config.refreshSchedule, config.refresh, from);
    this.repository.setNextRefreshAt(id, next);
    return next;
  }

  /** Record a finished refresh. A no-op when the toolbox is gone. */
  recordRefresh(id: string, status: ToolboxRefreshStatus): void {
    this.repository.setLastRefresh(id, status);
  }

  delete(id: string): void {
    this.get(id);
    this.repository.delete(id);
    log.info({ toolboxId: id }, "Toolbox config deleted");
  }

  /** The pinned toolbox-version pointer (docs/toolbox-versions.md §2) —
   * null means "resolve the recipe build every spawn" (today's behavior). */
  getActiveVersionId(id: string): string | null {
    return this.repository.getActiveVersionId(id);
  }

  /** Repoint (or clear, with `null`) the active pin. Free/instant — no build,
   * no ref mutation, just the pointer moving. */
  setActiveVersionId(id: string, versionId: string | null): void {
    this.repository.setActiveVersionId(id, versionId);
  }
}
