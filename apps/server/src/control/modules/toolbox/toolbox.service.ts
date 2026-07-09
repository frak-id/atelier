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
}
