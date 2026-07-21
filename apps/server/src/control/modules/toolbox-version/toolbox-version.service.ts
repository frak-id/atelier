/**
 * Toolbox version CRUD (docs/toolbox-versions.md §4). Pure control-plane
 * storage of `{ref, label, description, provenance}` rows associated with a
 * toolbox — it knows nothing about `runtime/` or how a `ref` was produced.
 * The api/ seam (`control.routes.ts`) is the only place that calls
 * `runtime.captureToolset` and then hands this service the resulting ref.
 */
import type { ToolboxVersion, ToolboxVersionProvenance } from "@atelier/spec";
import { NotFoundError } from "../../../shared/errors.ts";
import { safeNanoid } from "../../../shared/lib/id.ts";
import { createChildLogger } from "../../../shared/lib/logger.ts";
import type { ToolboxVersionRepository } from "./toolbox-version.repository.ts";

const log = createChildLogger("toolbox-version-service");

/** Keep at most this many version rows per toolbox (docs/toolbox-versions.md
 * §6 GC/retention) — beyond that, prune the oldest (never the active pin or
 * the newest `built` row). */
const TOOLBOX_VERSION_RETENTION = 10;

export class ToolboxVersionService {
  constructor(private readonly repository: ToolboxVersionRepository) {}

  listByToolbox(toolboxId: string): ToolboxVersion[] {
    return this.repository.listByToolbox(toolboxId);
  }

  get(id: string): ToolboxVersion {
    const version = this.repository.getById(id);
    if (!version) throw new NotFoundError("ToolboxVersion", id);
    return version;
  }

  /** Non-throwing lookup — for the spawn seam, where a dangling pin must fall
   * back to the recipe build rather than fail the whole spawn. */
  find(id: string): ToolboxVersion | undefined {
    return this.repository.getById(id);
  }

  create(
    toolboxId: string,
    input: {
      ref: string;
      description: string;
      provenance: ToolboxVersionProvenance;
      recipeFingerprint: string;
    },
  ): ToolboxVersion {
    const record: ToolboxVersion = {
      id: safeNanoid(),
      toolboxId,
      label: this.repository.nextLabel(toolboxId),
      ref: input.ref,
      description: input.description,
      provenance: input.provenance,
      recipeFingerprint: input.recipeFingerprint,
      createdAt: new Date().toISOString(),
    };
    log.info(
      { toolboxId, label: record.label, ref: record.ref },
      "Toolbox version created",
    );
    return this.repository.create(record);
  }

  delete(id: string): void {
    this.get(id);
    this.repository.delete(id);
    log.info({ versionId: id }, "Toolbox version deleted");
  }

  /** Whether this exact artifact ref already has a version row for this
   * toolbox — the cheap existence check the spawn seam gates lazy `built`-row
   * recording on, so the hot path (every spawn) stays a single indexed
   * lookup instead of an insert attempt. */
  existsByRef(toolboxId: string, ref: string): boolean {
    return this.repository.getByToolboxAndRef(toolboxId, ref) !== undefined;
  }

  /** Lazily record a recipe-built artifact as a version row, once per
   * distinct ref (docs/toolbox-versions.md §3). The seam calls `buildToolset`
   * on every spawn, but it's content-hash cached — the ref only changes when
   * the recipe changes — so this is idempotent: a second call for the same
   * ref is a no-op (returns undefined) rather than a duplicate row. */
  recordBuilt(
    toolboxId: string,
    input: { ref: string; recipeFingerprint: string; sourceImage?: string },
  ): ToolboxVersion | undefined {
    if (this.repository.getByToolboxAndRef(toolboxId, input.ref)) {
      return undefined;
    }
    return this.create(toolboxId, {
      ref: input.ref,
      description: "Recipe build",
      provenance: {
        kind: "built",
        recipeHash: input.recipeFingerprint,
        ...(input.sourceImage ? { sourceImage: input.sourceImage } : {}),
      },
      recipeFingerprint: input.recipeFingerprint,
    });
  }

  /** Enforce the retention policy (docs/toolbox-versions.md §6): keep the
   * newest `TOOLBOX_VERSION_RETENTION` versions, the active pin (if any), and
   * the newest `built` row (rollback-to-recipe must stay possible even if a
   * flurry of captures pushes it out of the newest-N window) — delete
   * everything else. Returns the deleted rows so the caller can also drop
   * their runtime toolset records. */
  pruneOldVersions(
    toolboxId: string,
    activeVersionId: string | null,
  ): ToolboxVersion[] {
    const versions = this.repository.listByToolbox(toolboxId); // asc by label
    const keep = new Set<string>();
    for (const v of versions.slice(-TOOLBOX_VERSION_RETENTION)) {
      keep.add(v.id);
    }
    if (activeVersionId) keep.add(activeVersionId);
    const newestBuilt = [...versions]
      .reverse()
      .find((v) => v.provenance.kind === "built");
    if (newestBuilt) keep.add(newestBuilt.id);

    const deleted: ToolboxVersion[] = [];
    for (const v of versions) {
      if (keep.has(v.id)) continue;
      this.repository.delete(v.id);
      deleted.push(v);
    }
    if (deleted.length > 0) {
      log.info(
        { toolboxId, count: deleted.length },
        "Toolbox versions pruned by retention policy",
      );
    }
    return deleted;
  }
}
