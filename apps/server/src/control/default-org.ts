/**
 * The team organization named by `auth.defaultOrg` (a slug). It is the default
 * spawn org, the org a new user joins as `member` on first login, and its
 * owners are the server admins (config, images, prebuild deletion).
 *
 * With no `defaultOrg` configured there is no admin concept: everyone is an
 * admin. Production refuses to start without it (`validateConfig`).
 * Auth-bypassed modes (local) are single-user: everyone is an admin there too.
 */
import { ForbiddenError, ValidationError } from "../shared/errors.ts";
import { config, isAuthBypassed } from "../shared/lib/config.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import type { OrgMemberService } from "./modules/org-member/index.ts";
import type { OrganizationService } from "./modules/organization/index.ts";

const log = createChildLogger("default-org");

export interface DefaultOrgDeps {
  organizationService: OrganizationService;
  orgMemberService: OrgMemberService;
}

export function createDefaultOrg({
  organizationService,
  orgMemberService,
}: DefaultOrgDeps) {
  /** The configured team org, when it is set and exists. */
  const defaultOrgId = (): string | undefined => {
    const slug = config.auth.defaultOrg;
    return slug ? organizationService.getBySlug(slug)?.id : undefined;
  };

  const isServerAdmin = (userId: string): boolean => {
    if (isAuthBypassed() || !config.auth.defaultOrg) return true;
    const orgId = defaultOrgId();
    if (!orgId) return false;
    return orgMemberService.getMembership(orgId, userId)?.role === "owner";
  };

  /** The team org is found by its slug, so its slug is its identity: whoever
   * holds that slug is the server admin. */
  const isDefaultSlug = (slug: string): boolean => {
    const reserved = config.auth.defaultOrg;
    return !!reserved && slug.toLowerCase() === reserved.toLowerCase();
  };

  return {
    defaultOrgId,
    isServerAdmin,
    /** `POST /api/organizations`: nobody creates the default slug through the
     * API (`joinDefaultOrg` bootstraps the org itself on a fresh install). */
    assertSlugCreatable(slug: string): void {
      if (isDefaultSlug(slug)) {
        throw new ValidationError(
          `Slug '${slug}' is reserved for the default organization`,
        );
      }
    },
    /** `PATCH /api/organizations/:id`: the default org keeps its slug, and no
     * other org may take it over. */
    assertSlugChangeAllowed(orgId: string, slug: string | undefined): void {
      const org = organizationService.getByIdOrThrow(orgId);
      if (slug === undefined || slug === org.slug) return;
      if (isDefaultSlug(org.slug)) {
        throw new ValidationError(
          "The default organization's slug can't be changed",
        );
      }
      if (isDefaultSlug(slug)) {
        throw new ValidationError(
          `Slug '${slug}' is reserved for the default organization`,
        );
      }
    },
    /** `DELETE /api/organizations/:id`: the default org can't be deleted. */
    assertDeletable(orgId: string): void {
      if (isDefaultSlug(organizationService.getByIdOrThrow(orgId).slug)) {
        throw new ValidationError("The default organization can't be deleted");
      }
    },
    requireServerAdmin(userId: string): void {
      if (!isServerAdmin(userId)) {
        throw new ForbiddenError(
          "Only the owners of the default organization can do this",
        );
      }
    },
    /**
     * First-login hook: add `userId` to the team org as `member`. A fresh
     * install has no such org yet: it is created with this user as its owner
     * (the first person through the GitHub gate administers the server).
     */
    joinDefaultOrg(userId: string): void {
      const slug = config.auth.defaultOrg;
      if (!slug) return;
      const existing = organizationService.getBySlug(slug);
      if (!existing) {
        const org = organizationService.create(slug, slug);
        orgMemberService.addMember(org.id, userId, "owner");
        log.info({ slug, userId }, "Default organization created");
        return;
      }
      if (!orgMemberService.getMembership(existing.id, userId)) {
        orgMemberService.addMember(existing.id, userId, "member");
      }
    },
  };
}
