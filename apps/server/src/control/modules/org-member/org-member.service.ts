import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../../../shared/errors.ts";
import { safeNanoid } from "../../../shared/lib/id.ts";
import { createChildLogger } from "../../../shared/lib/logger.ts";
import type { OrgMemberRole } from "../../db/schema.ts";
import type { OrgMember } from "../../types.ts";
import type { UserRepository } from "../user/user.repository.ts";
import type { OrgMemberRepository } from "./org-member.repository.ts";

const log = createChildLogger("org-member-service");

/**
 * The RBAC guard for the whole control layer. Two roles: `owner` (members,
 * secrets, rename/delete the org) and `member` (everything else in the org).
 * `requireOwner` is what every owner-only route calls.
 */
export class OrgMemberService {
  constructor(
    private readonly orgMemberRepository: OrgMemberRepository,
    private readonly userRepository: UserRepository,
  ) {}

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
    if (!member) throw new ForbiddenError("Not a member of this organization");
    return member;
  }

  /** Membership with the `owner` role, or a 403. */
  requireOwner(orgId: string, userId: string): OrgMember {
    const member = this.requireMembership(orgId, userId);
    if (member.role !== "owner") {
      throw new ForbiddenError("Only an organization owner can do this");
    }
    return member;
  }

  /** Add `userId` on behalf of `actorId` (an owner). */
  inviteMember(
    orgId: string,
    actorId: string,
    userId: string,
    role: OrgMemberRole = "member",
  ): OrgMember {
    this.requireOwner(orgId, actorId);
    return this.addMember(orgId, userId, role);
  }

  /** Unchecked insert — for system paths (org creation, personal org
   * bootstrap). Caller-driven adds go through `inviteMember`. */
  addMember(
    orgId: string,
    userId: string,
    role: OrgMemberRole = "member",
  ): OrgMember {
    const user = this.userRepository.getById(userId);
    if (!user) throw new NotFoundError("User", userId);
    if (this.orgMemberRepository.existsByOrgAndUser(orgId, userId)) {
      throw new ValidationError("User is already a member");
    }

    const id = safeNanoid(12);
    this.orgMemberRepository.create({
      id,
      orgId,
      userId,
      role,
      joinedAt: new Date().toISOString(),
    });

    const member = this.orgMemberRepository.getByOrgAndUser(orgId, userId);
    if (!member) throw new Error("Failed to create member");
    log.info({ orgId, userId, role }, "Member added to organization");
    return member;
  }

  /**
   * Change `targetId`'s role on behalf of `actorId` (an owner). An org always
   * keeps at least one owner.
   */
  updateRole(
    orgId: string,
    actorId: string,
    targetId: string,
    role: OrgMemberRole,
  ): OrgMember {
    this.requireOwner(orgId, actorId);
    const member = this.getMembership(orgId, targetId);
    if (!member) throw new NotFoundError("OrgMember", `${orgId}/${targetId}`);
    if (member.role === "owner" && role !== "owner") {
      this.assertNotLastOwner(orgId);
    }

    this.orgMemberRepository.updateRole(member.id, role);
    const updated = this.orgMemberRepository.getByOrgAndUser(orgId, targetId);
    if (!updated) throw new Error("Failed to update member");
    log.info({ orgId, actorId, targetId, role }, "Member role changed");
    return updated;
  }

  /**
   * Remove `targetId` from the org on behalf of `actorId`. Anyone may leave
   * (`actorId === targetId`); otherwise only an owner removes someone. The
   * last owner can never leave or be removed.
   */
  removeMember(orgId: string, actorId: string, targetId: string): void {
    const member = this.getMembership(orgId, targetId);
    if (actorId === targetId) {
      if (!member)
        throw new ForbiddenError("Not a member of this organization");
    } else {
      this.requireOwner(orgId, actorId);
      if (!member) {
        throw new NotFoundError("OrgMember", `${orgId}/${targetId}`);
      }
    }
    if (member.role === "owner") this.assertNotLastOwner(orgId);

    this.orgMemberRepository.deleteByOrgAndUser(orgId, targetId);
    log.info({ orgId, actorId, targetId }, "Member removed from organization");
  }

  private assertNotLastOwner(orgId: string): void {
    const owners = this.orgMemberRepository
      .getByOrgId(orgId)
      .filter((m) => m.role === "owner").length;
    if (owners <= 1) {
      throw new ValidationError(
        "An organization needs at least one owner: promote someone else first",
      );
    }
  }
}
