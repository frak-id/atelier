/**
 * Picking the caller's default organization (`organizationsListQuery`):
 * used wherever a UI needs to preselect an org before the caller picks one
 * explicitly (spawning a sandbox).
 */

export interface OrgSummaryLike {
  id: string;
  /** The caller's OWN personal org (someone else's personal org they were
   * invited to is `personal` but not `mine`). */
  mine?: boolean;
  /** The team org named by the server's `auth.defaultOrg`. */
  default?: boolean;
}

/**
 * The server's spawn default: the team org (`auth.defaultOrg`), else the
 * caller's personal org, else the first org they belong to, or "" if they
 * belong to none.
 */
export function pickDefaultOrgId(
  orgs: readonly OrgSummaryLike[] | undefined,
): string {
  return (
    (
      orgs?.find((org) => org.default) ??
      orgs?.find((org) => org.mine) ??
      orgs?.[0]
    )?.id ?? ""
  );
}

type OrgRole = "owner" | "member";

interface OrgWithRoleLike extends OrgSummaryLike {
  name: string;
  role: OrgRole;
}

/** One org a settings page lists records for. */
export interface OwnerScope {
  /** The `?owner=` string the API takes: `org:<id>`. */
  owner: string;
  orgId: string;
  label: string;
  /** The caller's personal org (see `OrgSummaryLike.mine`). */
  mine: boolean;
  /** The team org (see `OrgSummaryLike.default`). */
  isDefault: boolean;
  role: OrgRole;
  /** Owner of the org. Members can use and edit its toolboxes but not write
   * its secrets — pages pick the rule that matches their record type. */
  isOwner: boolean;
}

/**
 * Every org a settings page shows as its own section: the caller's personal
 * org first, then every other org in the server's order.
 */
export function ownerScopes(orgs: readonly OrgWithRoleLike[]): OwnerScope[] {
  const sorted = [
    ...orgs.filter((org) => org.mine),
    ...orgs.filter((org) => !org.mine),
  ];
  return sorted.map((org) => ({
    owner: `org:${org.id}`,
    orgId: org.id,
    label: org.name,
    mine: org.mine === true,
    isDefault: org.default === true,
    role: org.role,
    isOwner: org.role === "owner",
  }));
}
