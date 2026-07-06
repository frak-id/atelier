import type { SandboxSpec } from "@atelier/spec";
import { NotFoundError } from "../../../shared/errors.ts";
import { safeNanoid } from "../../../shared/lib/id.ts";
import { createChildLogger } from "../../../shared/lib/logger.ts";
import type {
  SavedSpec,
  SavedSpecRepository,
  TemplateMeta,
} from "./saved-spec.repository.ts";

const log = createChildLogger("saved-spec-service");

export class SavedSpecService {
  constructor(private readonly repository: SavedSpecRepository) {}

  getAll(): SavedSpec[] {
    return this.repository.getAll();
  }

  getByOrgIds(orgIds: string[]): SavedSpec[] {
    return this.repository.getByOrgIds(orgIds);
  }

  getById(id: string): SavedSpec | undefined {
    return this.repository.getById(id);
  }

  getByIdOrThrow(id: string): SavedSpec {
    const spec = this.repository.getById(id);
    if (!spec) throw new NotFoundError("SavedSpec", id);
    return spec;
  }

  create(
    name: string,
    spec: SandboxSpec,
    orgId?: string,
    options?: { template?: boolean; meta?: TemplateMeta | null },
  ): SavedSpec {
    const now = new Date().toISOString();
    const record: SavedSpec = {
      id: safeNanoid(12),
      orgId,
      name,
      spec,
      policyRefs: [],
      template: options?.template ?? false,
      meta: options?.meta ?? null,
      createdAt: now,
      updatedAt: now,
    };
    log.info({ savedSpecId: record.id, name }, "Saved spec created");
    return this.repository.create(record);
  }

  update(
    id: string,
    updates: {
      name?: string;
      spec?: SandboxSpec;
      template?: boolean;
      meta?: TemplateMeta | null;
    },
  ): SavedSpec {
    this.getByIdOrThrow(id);
    const updated = this.repository.update(id, updates);
    if (!updated) throw new NotFoundError("SavedSpec", id);
    return updated;
  }

  delete(id: string): void {
    this.getByIdOrThrow(id);
    this.repository.delete(id);
    log.info({ savedSpecId: id }, "Saved spec deleted");
  }
}
