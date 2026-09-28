import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../../../shared/errors.ts";
import { safeNanoid } from "../../../shared/lib/id.ts";
import { createChildLogger } from "../../../shared/lib/logger.ts";
import type { Organization, OrganizationWithRole } from "../../types.ts";
import type { OrganizationRepository } from "./organization.repository.ts";

const log = createChildLogger("organization-service");

export class OrganizationService {
  constructor(
    private readonly organizationRepository: OrganizationRepository,
  ) {}

  getAll(): Organization[] {
    return this.organizationRepository.getAll();
  }

  getById(id: string): Organization | undefined {
    return this.organizationRepository.getById(id);
  }

  getByIdOrThrow(id: string): Organization {
    const org = this.organizationRepository.getById(id);
    if (!org) throw new NotFoundError("Organization", id);
    return org;
  }

  getBySlug(slug: string): Organization | undefined {
    return this.organizationRepository.getBySlug(slug);
  }

  getBySlugOrThrow(slug: string): Organization {
    const org = this.organizationRepository.getBySlug(slug);
    if (!org) throw new NotFoundError("Organization", slug);
    return org;
  }

  getByUserId(userId: string): OrganizationWithRole[] {
    return this.organizationRepository.getByUserId(userId);
  }

  create(name: string, slug: string, personal = false): Organization {
    const now = new Date().toISOString();
    const organization: Organization = {
      id: safeNanoid(12),
      name,
      slug,
      personal,
      createdAt: now,
      updatedAt: now,
    };
    log.info({ organizationId: organization.id }, "Creating organization");
    return this.organizationRepository.create(organization);
  }

  /** Rename (display name and/or slug). The id never changes, so nothing
   * keyed on it (toolbox artifacts, secrets, members) is affected. */
  rename(id: string, updates: { name?: string; slug?: string }): Organization {
    const org = this.getByIdOrThrow(id);
    const name = updates.name?.trim();
    if (updates.name !== undefined && !name) {
      throw new ValidationError("Name can't be empty");
    }
    if (updates.slug !== undefined && updates.slug !== org.slug) {
      const taken = this.organizationRepository.getBySlug(updates.slug);
      if (taken) throw new ConflictError(`Slug '${updates.slug}' is taken`);
    }
    const updated = this.organizationRepository.update(id, {
      ...(name ? { name } : {}),
      ...(updates.slug !== undefined ? { slug: updates.slug } : {}),
    });
    log.info({ organizationId: id }, "Organization renamed");
    return updated;
  }

  /** Delete a team org and its memberships. Personal orgs can't be deleted
   * (every user keeps one); resource checks are the caller's job. */
  delete(id: string): void {
    const org = this.getByIdOrThrow(id);
    if (org.personal) {
      throw new ValidationError("A personal organization can't be deleted");
    }
    this.organizationRepository.delete(id);
    log.info({ organizationId: id }, "Organization deleted");
  }

  count(): number {
    return this.organizationRepository.count();
  }
}
