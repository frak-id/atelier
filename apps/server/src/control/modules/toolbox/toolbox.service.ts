/**
 * Org-scoped toolbox config CRUD (per-org-toolboxes.md §4). The api/ seam
 * (`container.ts` `resolveOrgToolboxRefs`) turns `listEnabled()` results into
 * built `ToolsetRef`s at spawn time; this service knows nothing about
 * `runtime/` or building — pure control-plane config storage.
 */
import { DEFAULT_TOOLBOX } from "@atelier/compose";
import type {
  ToolboxConfig,
  ToolboxConfigInput,
  ToolboxConfigPatch,
} from "@atelier/spec";
import { NotFoundError, ValidationError } from "../../../shared/errors.ts";
import { safeNanoid } from "../../../shared/lib/id.ts";
import { createChildLogger } from "../../../shared/lib/logger.ts";
import type { ToolboxRepository } from "./toolbox.repository.ts";

const log = createChildLogger("toolbox-service");

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

export class ToolboxService {
  constructor(private readonly repository: ToolboxRepository) {}

  list(orgId: string): ToolboxConfig[] {
    return this.repository.list(orgId);
  }

  /** Enabled toolboxes, oldest-first — the spawn-injection order (R6). */
  listEnabled(orgId: string): ToolboxConfig[] {
    return this.repository.listEnabled(orgId);
  }

  get(id: string): ToolboxConfig {
    const config = this.repository.getById(id);
    if (!config) throw new NotFoundError("ToolboxConfig", id);
    return config;
  }

  create(orgId: string, input: ToolboxConfigInput): ToolboxConfig {
    if (this.repository.getByOrgAndSlug(orgId, input.slug)) {
      throw new ValidationError(
        `A toolbox with slug '${input.slug}' already exists for this org`,
      );
    }
    const now = new Date().toISOString();
    const record: ToolboxConfig = {
      id: safeNanoid(12),
      orgId,
      slug: input.slug,
      description: input.description,
      source: input.source,
      build: input.build,
      paths: input.paths,
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    };
    log.info({ orgId, slug: input.slug }, "Toolbox config created");
    return this.repository.create(record);
  }

  update(id: string, patch: ToolboxConfigPatch): ToolboxConfig {
    this.get(id);
    const updated = this.repository.update(id, patch);
    if (!updated) throw new NotFoundError("ToolboxConfig", id);
    return updated;
  }

  delete(id: string): void {
    this.get(id);
    this.repository.delete(id);
    log.info({ toolboxId: id }, "Toolbox config deleted");
  }

  /**
   * Seed the default toolbox for an org. Conflict-safe against
   * `uniqueIndex(org_id, slug)` (R3): check-then-insert, swallowing a benign
   * race onto the same slug rather than assuming the org is empty.
   */
  seedDefault(orgId: string): ToolboxConfig {
    const existing = this.repository.getByOrgAndSlug(
      orgId,
      DEFAULT_TOOLBOX.slug,
    );
    if (existing) return existing;

    const now = new Date().toISOString();
    const record: ToolboxConfig = {
      id: safeNanoid(12),
      orgId,
      slug: DEFAULT_TOOLBOX.slug,
      description: DEFAULT_TOOLBOX.description,
      source: DEFAULT_TOOLBOX.source,
      build: DEFAULT_TOOLBOX.build,
      paths: DEFAULT_TOOLBOX.paths,
      enabled: DEFAULT_TOOLBOX.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    };
    try {
      return this.repository.create(record);
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
      const raced = this.repository.getByOrgAndSlug(orgId, record.slug);
      if (!raced) throw err;
      return raced;
    }
  }

  /**
   * Backfill: seed the default for every org with ZERO toolboxes (R4). Never
   * resurrects a deliberately-deleted default — the guard is org-emptiness,
   * not "does the default slug exist".
   */
  ensureDefaults(orgIds: string[]): void {
    for (const orgId of orgIds) {
      if (this.repository.list(orgId).length === 0) {
        this.seedDefault(orgId);
      }
    }
  }
}
