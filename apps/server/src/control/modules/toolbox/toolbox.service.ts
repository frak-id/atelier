/**
 * Entity-scoped toolbox config CRUD (entities-toolbox.md §4). The api/ seam
 * (`container.ts` `resolveToolboxRefs`) turns `listEnabled()` results into
 * built `ToolsetRef`s at spawn time; this service knows nothing about
 * `runtime/` or building — pure control-plane config storage.
 *
 * A toolbox is owned by an `org` (place-scoped, mandated baseline) or a `user`
 * (identity-scoped, personal overlay). Seeding is asymmetric on purpose: orgs
 * get the `DEFAULT_TOOLBOX` (opencode + code-server), users seed nothing
 * (bring-your-own) — this is what prevents double-injecting opencode.
 */
import { DEFAULT_TOOLBOX } from "@atelier/compose";
import type {
  ToolboxConfig,
  ToolboxConfigInput,
  ToolboxConfigPatch,
  ToolboxOwner,
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

  list(owner: ToolboxOwner): ToolboxConfig[] {
    return this.repository.list(owner);
  }

  /** Auto-inject toolboxes, oldest-first — the spawn-injection order (R6). */
  listAutoInject(owner: ToolboxOwner): ToolboxConfig[] {
    return this.repository.listAutoInject(owner);
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

  /**
   * Seed the default toolbox for an org (users never seed — asymmetric by
   * design). Conflict-safe against `uniqueIndex(owner_type, owner_id, slug)`
   * (R3): check-then-insert, swallowing a benign race onto the same slug
   * rather than assuming the org is empty.
   */
  seedDefault(orgId: string): ToolboxConfig {
    const owner: ToolboxOwner = { type: "org", id: orgId };
    const existing = this.repository.getByOwnerAndSlug(
      owner,
      DEFAULT_TOOLBOX.slug,
    );
    if (existing) return existing;

    const now = new Date().toISOString();
    const record: ToolboxConfig = {
      id: safeNanoid(12),
      ownerType: owner.type,
      ownerId: owner.id,
      slug: DEFAULT_TOOLBOX.slug,
      description: DEFAULT_TOOLBOX.description,
      source: DEFAULT_TOOLBOX.source,
      build: DEFAULT_TOOLBOX.build,
      paths: DEFAULT_TOOLBOX.paths,
      harness: DEFAULT_TOOLBOX.harness,
      processes: DEFAULT_TOOLBOX.processes,
      ports: DEFAULT_TOOLBOX.ports,
      autoInject: DEFAULT_TOOLBOX.autoInject ?? true,
      createdAt: now,
      updatedAt: now,
    };
    try {
      return this.repository.create(record);
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
      const raced = this.repository.getByOwnerAndSlug(owner, record.slug);
      if (!raced) throw err;
      return raced;
    }
  }

  /**
   * Backfill: seed the default for every org with ZERO toolboxes (R4). Stays
   * org-only — users are never auto-seeded. Never resurrects a deliberately-
   * deleted default; the guard is org-emptiness, not "does the default slug
   * exist".
   */
  ensureDefaults(orgIds: string[]): void {
    for (const orgId of orgIds) {
      if (this.repository.list({ type: "org", id: orgId }).length === 0) {
        this.seedDefault(orgId);
      }
    }
  }
}
