/**
 * Toolbox ownership scoping + authorization \u2014 shared by `/api/toolboxes`
 * (control.routes.ts) and the `list_toolboxes`/`manage_toolbox` MCP tools.
 * One set of invariants, two callers.
 */
import type { ToolboxOwner } from "@atelier/spec";
import type { ControlContainer } from "../control/index.ts";
import { ForbiddenError, ValidationError } from "../shared/errors.ts";

/**
 * Parse + authorize the `owner=` scope for a GET/POST toolbox request.
 * Grammar: `org:<id>` | `user:<id>` | `user` | `me` (alias for the caller).
 * Absent \u2192 default to the caller (`user:<me>`) \u2014 the "My Toolboxes" home;
 * we do NOT fall back to an org, so an org's private build scripts are never
 * the implicit default (entities-toolbox.md D7).
 *
 * AuthZ per owner type: org \u2192 `requireRole(owner/admin)` (write) or
 * `requireMembership` (read); user \u2192 self-only (a user may only ever scope
 * to their own id).
 */
export function resolveOwner(
  control: ControlContainer,
  userId: string,
  ownerParam: string | undefined,
  write: boolean,
): ToolboxOwner {
  if (!ownerParam || ownerParam === "me" || ownerParam === "user") {
    return { type: "user", id: userId };
  }
  const [type, id] = ownerParam.split(":", 2);
  if (type === "user") {
    const targetId = !id || id === "me" ? userId : id;
    if (targetId !== userId) {
      throw new ForbiddenError("Cannot access another user's toolboxes");
    }
    return { type: "user", id: userId };
  }
  if (type === "org") {
    if (!id) throw new ValidationError("owner=org: requires an org id");
    if (write) {
      control.orgMemberService.requireRole(id, userId, ["owner", "admin"]);
    } else {
      control.orgMemberService.requireMembership(id, userId);
    }
    return { type: "org", id };
  }
  throw new ValidationError(`Invalid owner scope '${ownerParam}'`);
}

/**
 * Authorize a mutation against the STORED record's owner (never a caller-
 * supplied scope) \u2014 the security-critical spot for PATCH/DELETE. Org \u2192
 * owner/admin of the record's org; user \u2192 the record's owner only (org
 * admins do NOT manage members' personal toolboxes).
 */
export function requireToolboxOwnerAccess(
  control: ControlContainer,
  toolbox: { ownerType: ToolboxOwner["type"]; ownerId: string },
  userId: string,
): void {
  if (toolbox.ownerType === "org") {
    control.orgMemberService.requireRole(toolbox.ownerId, userId, [
      "owner",
      "admin",
    ]);
    return;
  }
  if (toolbox.ownerType === "user") {
    if (toolbox.ownerId !== userId) {
      throw new ForbiddenError("Cannot manage another user's toolbox");
    }
    return;
  }
  // Fail closed on any unexpected owner type (defense-in-depth: the typed
  // service layer should make this unreachable).
  throw new ForbiddenError("Unknown toolbox owner");
}
