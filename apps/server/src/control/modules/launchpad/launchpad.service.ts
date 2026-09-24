/**
 * Launchpad control-plane storage (docs/proposals/launchpad.md): starters
 * (the tech team's curated recipes) and workspaces (a user's launched
 * sandboxes, with their own title/description). Pure config + identity
 * storage — launching, status and autostart live at the api/ seam, which is
 * the only layer that sees both control and runtime.
 */
import {
  type Starter,
  type StarterInput,
  type StarterPatch,
  starterInputProblems,
  type ToolboxOwner,
  type WorkspacePatch,
  type WorkspaceSnapshot,
} from "@atelier/spec";
import { NotFoundError, ValidationError } from "../../../shared/errors.ts";
import { safeNanoid } from "../../../shared/lib/id.ts";
import { createChildLogger } from "../../../shared/lib/logger.ts";
import type { StarterRepository } from "./starter.repository.ts";
import type {
  WorkspaceRecord,
  WorkspaceRepository,
} from "./workspace.repository.ts";

const log = createChildLogger("launchpad");

function assertValid(input: Pick<StarterInput, "services">): void {
  const problems = starterInputProblems(input);
  if (problems.length > 0) throw new ValidationError(problems.join("; "));
}

/** Trim, and treat an all-blank optional text as "unset". */
function optionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export class StarterService {
  constructor(private readonly repository: StarterRepository) {}

  list(owner: ToolboxOwner): Starter[] {
    return this.repository.list(owner);
  }

  /** The Launchpad catalog: published starters of every given owner. */
  listPublished(owners: ToolboxOwner[]): Starter[] {
    return this.repository.listPublished(owners);
  }

  get(id: string): Starter {
    const starter = this.repository.getById(id);
    if (!starter) throw new NotFoundError("Starter", id);
    return starter;
  }

  create(owner: ToolboxOwner, input: StarterInput): Starter {
    assertValid(input);
    const now = new Date().toISOString();
    const starter: Starter = {
      id: safeNanoid(12),
      ownerType: owner.type,
      ownerId: owner.id,
      title: input.title.trim(),
      description: input.description.trim(),
      ...(optionalText(input.icon) ? { icon: optionalText(input.icon) } : {}),
      ...(optionalText(input.guide)
        ? { guide: optionalText(input.guide) }
        : {}),
      published: input.published ?? true,
      recipe: input.recipe,
      services: input.services,
      createdAt: now,
      updatedAt: now,
    };
    log.info(
      { ownerType: owner.type, ownerId: owner.id, starterId: starter.id },
      "Starter created",
    );
    return this.repository.create(starter);
  }

  /** Absent keys keep their value; an empty `icon`/`guide` clears it. */
  update(id: string, patch: StarterPatch): Starter {
    const existing = this.get(id);
    const merged: Starter = {
      ...existing,
      ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
      ...(patch.description !== undefined
        ? { description: patch.description.trim() }
        : {}),
      ...(patch.published !== undefined ? { published: patch.published } : {}),
      ...(patch.recipe !== undefined ? { recipe: patch.recipe } : {}),
      ...(patch.services !== undefined ? { services: patch.services } : {}),
      updatedAt: new Date().toISOString(),
    };
    if (patch.icon !== undefined) merged.icon = optionalText(patch.icon);
    if (patch.guide !== undefined) merged.guide = optionalText(patch.guide);
    assertValid(merged);
    return this.repository.save(merged);
  }

  delete(id: string): void {
    this.get(id);
    this.repository.delete(id);
    log.info({ starterId: id }, "Starter deleted");
  }
}

export class WorkspaceService {
  constructor(private readonly repository: WorkspaceRepository) {}

  listByUser(userId: string): WorkspaceRecord[] {
    return this.repository.listByUser(userId);
  }

  /**
   * The caller's workspace, or a 404 — also for someone else's, so a
   * workspace id never leaks whether it exists.
   */
  getOwned(sandboxId: string, userId: string): WorkspaceRecord {
    const record = this.repository.get(sandboxId);
    if (!record || record.userId !== userId) {
      throw new NotFoundError("Workspace", sandboxId);
    }
    return record;
  }

  create(input: {
    sandboxId: string;
    userId: string;
    starterId?: string;
    jobId?: string;
    title: string;
    description?: string;
    snapshot: WorkspaceSnapshot;
  }): WorkspaceRecord {
    const now = new Date().toISOString();
    return this.repository.create({
      sandboxId: input.sandboxId,
      userId: input.userId,
      ...(input.starterId ? { starterId: input.starterId } : {}),
      ...(input.jobId ? { jobId: input.jobId } : {}),
      title: input.title.trim(),
      description: input.description?.trim() ?? "",
      snapshot: input.snapshot,
      createdAt: now,
      updatedAt: now,
    });
  }

  update(
    sandboxId: string,
    userId: string,
    patch: WorkspacePatch,
  ): WorkspaceRecord {
    this.getOwned(sandboxId, userId);
    const title = patch.title?.trim();
    if (patch.title !== undefined && !title) {
      throw new ValidationError("A workspace needs a name");
    }
    this.repository.update(sandboxId, {
      ...(title ? { title } : {}),
      ...(patch.description !== undefined
        ? { description: patch.description.trim() }
        : {}),
    });
    return this.getOwned(sandboxId, userId);
  }

  /** Point the row at a new launch job (retry) and bump its recency. */
  setJob(sandboxId: string, jobId: string): void {
    this.repository.update(sandboxId, { jobId });
  }

  /** Bump recency (wake-up) so it floats to the top of "jump back in". */
  touch(sandboxId: string): void {
    this.repository.update(sandboxId, {});
  }

  delete(sandboxId: string): void {
    this.repository.delete(sandboxId);
  }
}
