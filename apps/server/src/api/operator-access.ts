import type { ControlContainer } from "../control/index.ts";
import { ForbiddenError } from "../shared/errors.ts";

/**
 * Gate for server-wide operations (`/v1/images*` builds — an arbitrary
 * Dockerfile run as a root-equivalent build against the host's docker daemon
 * — and org-less global secrets, which are injected into every org's
 * sandboxes). There is genuinely no server-wide admin/operator role today
 * (see `control.routes.ts`'s `configRoutes` comment: "no server-admin role
 * yet"). This reuses control's existing org-scoped RBAC primitive
 * (`OrgMemberService.requireRole`, `OrgMemberRole = owner|admin|member|
 * viewer`) as the smallest correct proxy: the caller must be `owner` or
 * `admin` of at least one organization they belong to. Revisit once a real
 * server-wide admin role exists — this is an explicit assumption, not a new
 * permissions system.
 */
export function requireServerOperator(
  control: ControlContainer,
  userId: string,
  action: string,
): void {
  const isOperator = control.orgMemberService
    .getByUserId(userId)
    .some((m) => m.role === "owner" || m.role === "admin");
  if (!isOperator) {
    throw new ForbiddenError(
      `${action} requires an owner/admin role in at least one organization.`,
    );
  }
}
