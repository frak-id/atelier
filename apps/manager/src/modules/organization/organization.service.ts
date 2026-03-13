import { eventBus } from "../../infrastructure/events/index.ts";
import type { Organization } from "../../schemas/index.ts";
import { NotFoundError } from "../../shared/errors.ts";
import { safeNanoid } from "../../shared/lib/id.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
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
    const organization = this.organizationRepository.getById(id);
    if (!organization) {
      throw new NotFoundError("Organization", id);
    }
    return organization;
  }

  getBySlug(slug: string): Organization | undefined {
    return this.organizationRepository.getBySlug(slug);
  }

  getBySlugOrThrow(slug: string): Organization {
    const organization = this.organizationRepository.getBySlug(slug);
    if (!organization) {
      throw new NotFoundError("Organization", slug);
    }
    return organization;
  }

  getByUserId(userId: string): Organization[] {
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

    log.info(
      { organizationId: organization.id, name: organization.name },
      "Creating organization",
    );
    this.organizationRepository.create(organization);
    eventBus.emit({
      type: "organization.created",
      properties: { id: organization.id },
    });

    return organization;
  }

  update(
    id: string,
    updates: { name?: string; avatarUrl?: string },
  ): Organization {
    this.getByIdOrThrow(id);

    log.info({ organizationId: id }, "Updating organization");

    const organizationUpdates: Partial<Organization> = {};
    if (updates.name !== undefined) {
      organizationUpdates.name = updates.name;
    }
    if (updates.avatarUrl !== undefined) {
      organizationUpdates.avatarUrl = updates.avatarUrl;
    }

    const updated = this.organizationRepository.update(id, organizationUpdates);
    eventBus.emit({
      type: "organization.updated",
      properties: { id },
    });
    return updated;
  }

  delete(id: string): void {
    this.getByIdOrThrow(id);
    log.info({ organizationId: id }, "Deleting organization");
    this.organizationRepository.delete(id);
    eventBus.emit({
      type: "organization.deleted",
      properties: { id },
    });
  }

  count(): number {
    return this.organizationRepository.count();
  }
}
