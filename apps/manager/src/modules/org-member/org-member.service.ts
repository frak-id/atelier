import type { OrgMemberRole } from "../../infrastructure/database/index.ts";
import type { OrgMember } from "../../schemas/index.ts";
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../../shared/errors.ts";
import { safeNanoid } from "../../shared/lib/id.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import type { OrgMemberRepository } from "./org-member.repository.ts";

const log = createChildLogger("org-member-service");

export class OrgMemberService {
  constructor(private readonly orgMemberRepository: OrgMemberRepository) {}

  getByOrgId(orgId: string): OrgMember[] {
    return this.orgMemberRepository.getByOrgId(orgId);
  }

  getByUserId(userId: string): OrgMember[] {
    return this.orgMemberRepository.getByUserId(userId);
  }

  getMembership(orgId: string, userId: string): OrgMember | undefined {
    return this.orgMemberRepository.getByOrgAndUser(orgId, userId);
  }

  requireMembership(orgId: string, userId: string): OrgMember {
    const member = this.getMembership(orgId, userId);
    if (!member) {
      throw new ForbiddenError("Not a member of this organization");
    }
    return member;
  }

  requireRole(
    orgId: string,
    userId: string,
    minimumRoles: string[],
  ): OrgMember {
    const member = this.requireMembership(orgId, userId);
    if (!minimumRoles.includes(member.role)) {
      throw new ForbiddenError("Insufficient permissions");
    }
    return member;
  }

  addMember(
    orgId: string,
    userId: string,
    role: OrgMemberRole = "member",
  ): OrgMember {
    const existing = this.getMembership(orgId, userId);
    if (existing) {
      throw new ValidationError("User is already a member");
    }

    const id = safeNanoid(12);
    const now = new Date().toISOString();

    this.orgMemberRepository.create({
      id,
      orgId,
      userId,
      role,
      joinedAt: now,
    });

    const member = this.orgMemberRepository.getByOrgAndUser(orgId, userId);
    if (!member) {
      throw new Error("Failed to create member");
    }

    log.info({ orgId, userId, role }, "Member added to organization");
    return member;
  }

  updateRole(orgId: string, userId: string, role: OrgMemberRole): OrgMember {
    const member = this.getMembership(orgId, userId);
    if (!member) {
      throw new NotFoundError("OrgMember", `${orgId}/${userId}`);
    }

    if (member.role === "owner" && role !== "owner") {
      const ownerCount = this.orgMemberRepository
        .getByOrgId(orgId)
        .filter((m) => m.role === "owner").length;
      if (ownerCount === 1) {
        throw new ValidationError("Cannot remove the last owner");
      }
    }

    this.orgMemberRepository.updateRole(member.id, role);

    const updated = this.orgMemberRepository.getByOrgAndUser(orgId, userId);
    if (!updated) {
      throw new Error("Failed to update member");
    }

    return updated;
  }

  removeMember(orgId: string, userId: string): void {
    const member = this.getMembership(orgId, userId);
    if (!member) {
      throw new NotFoundError("OrgMember", `${orgId}/${userId}`);
    }

    if (member.role === "owner") {
      const ownerCount = this.orgMemberRepository
        .getByOrgId(orgId)
        .filter((m) => m.role === "owner").length;
      if (ownerCount === 1) {
        throw new ValidationError("Cannot remove the last owner");
      }
    }

    this.orgMemberRepository.deleteByOrgAndUser(orgId, userId);
    log.info({ orgId, userId }, "Member removed from organization");
  }
}
