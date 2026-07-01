import { NotFoundError } from "../../../shared/errors.ts";
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

  update(id: string, updates: { name?: string; avatarUrl?: string }) {
    this.getByIdOrThrow(id);
    return this.organizationRepository.update(id, updates);
  }

  delete(id: string): void {
    this.getByIdOrThrow(id);
    this.organizationRepository.delete(id);
    log.info({ organizationId: id }, "Organization deleted");
  }

  count(): number {
    return this.organizationRepository.count();
  }
}
