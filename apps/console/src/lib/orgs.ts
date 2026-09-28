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
