/**
 * Picking the caller's default organization (`organizationsListQuery`):
 * used wherever a UI needs to preselect an org before the caller picks one
 * explicitly — spawning a sandbox, authoring a Launchpad starter.
 */

export interface OrgSummaryLike {
  id: string;
  /** The caller's OWN personal org (someone else's personal org they were
   * invited to is `personal` but not `mine`). */
  mine?: boolean;
}

/**
 * The caller's personal org id (the server's spawn default too), else the
 * first org they belong to, or "" if they belong to none.
 */
export function pickDefaultOrgId(
  orgs: readonly OrgSummaryLike[] | undefined,
): string {
  return (orgs?.find((org) => org.mine) ?? orgs?.[0])?.id ?? "";
}

type OrgRole = "owner" | "admin" | "member" | "viewer";

interface OrgWithRoleLike extends OrgSummaryLike {
  name: string;
  role: OrgRole;
}

/** One owner a settings page lists records for: the caller (`user`) or one
 * of their orgs. */
export interface OwnerScope {
  /** The `?owner=` string the API takes: `user` or `org:<id>`. */
  owner: string;
  /** The org's id; undefined for the caller's own `user` scope. */
  orgId?: string;
  label: string;
  /** The caller's personal org (see `OrgSummaryLike.mine`). */
  mine: boolean;
  /** The caller's role in the org; undefined for the `user` scope. */
  role?: OrgRole;
  /** Owner/admin of the org, always true for `user` — mirrors the server's
   * owner-scoped write check (`requireToolboxOwnerAccess`). */
  canManage: boolean;
}

/**
 * Every scope a settings page shows as its own section: the caller's own
 * `user` scope first (when the record type has one), then their personal
 * org, then every other org in the server's order.
 */
export function ownerScopes(
  orgs: readonly OrgWithRoleLike[],
  options: { includeUser: boolean },
): OwnerScope[] {
  const sorted = [
    ...orgs.filter((org) => org.mine),
    ...orgs.filter((org) => !org.mine),
  ];
  const scopes: OwnerScope[] = sorted.map((org) => ({
    owner: `org:${org.id}`,
    orgId: org.id,
    label: org.name,
    mine: org.mine === true,
    role: org.role,
    canManage: org.role === "owner" || org.role === "admin",
  }));
  return options.includeUser
    ? [
        {
          owner: "user",
          label: "Personal",
          mine: true,
          canManage: true,
        },
        ...scopes,
      ]
    : scopes;
}
