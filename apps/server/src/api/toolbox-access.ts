/**
 * Org scoping + authorization for toolboxes (`/api/toolboxes`, the
 * `list_toolboxes`/`manage_toolbox` MCP tools). Toolboxes belong to an org
 * ("personal" means the caller's personal org); any member of the org may
 * use, create and edit them.
 */
import type { ControlContainer } from "../control/index.ts";
import { ValidationError } from "../shared/errors.ts";

/**
 * Parse + authorize the `owner=` scope for a toolbox request.
 * Grammar: `org:<id>` | `me` (alias `user`, `personal`: the caller's personal
 * org). Absent defaults to the caller's personal org, so a team org's
 * toolboxes are never the implicit default. The caller must belong to the org.
 */
export function resolveToolboxOrg(
  control: ControlContainer,
  userId: string,
  ownerParam: string | undefined,
): string {
  if (
    !ownerParam ||
    ownerParam === "me" ||
    ownerParam === "user" ||
    ownerParam === "personal"
  ) {
    const personalOrgId = control.userService.getById(userId)?.personalOrgId;
    if (!personalOrgId) {
      throw new ValidationError("You have no personal organization yet");
    }
    return personalOrgId;
  }
  const [type, id] = ownerParam.split(":", 2);
  if (type !== "org" || !id) {
    throw new ValidationError(`Invalid owner scope '${ownerParam}'`);
  }
  control.orgMemberService.requireMembership(id, userId);
  return id;
}

/** Authorize a read or mutation against the STORED record's org (never a
 * caller-supplied scope): the caller must be a member of it. */
export function requireToolboxAccess(
  control: ControlContainer,
  toolbox: { orgId: string },
  userId: string,
): void {
  control.orgMemberService.requireMembership(toolbox.orgId, userId);
}

/** Every org whose toolboxes the caller can read: the ones they belong to. */
export function readableOrgIds(
  control: ControlContainer,
  userId: string,
): string[] {
  return control.orgMemberService.getByUserId(userId).map((m) => m.orgId);
}
