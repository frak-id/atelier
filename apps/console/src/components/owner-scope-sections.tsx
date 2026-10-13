import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useMemo } from "react";
import { organizationsListQuery } from "@/api/queries/organizations";
import { Badge } from "@/components/ui/badge";
import { CollapsibleSection } from "@/components/ui/collapsible-section";
import { Skeleton } from "@/components/ui/skeleton";
import { type OwnerScope, ownerScopes } from "@/lib/orgs";

/**
 * Every owner scope of an owner-scoped settings page, one section each,
 * instead of a scope picker: the caller's own records (`includeUser`), then
 * their personal org, then every other org. `children` renders one scope,
 * usually as an `OwnerScopeSection`.
 */
export function OwnerScopeSections({
  includeUser,
  children,
}: {
  /** List the caller's own `user` scope (toolboxes have one; org-only
   * records like secrets or starters don't). */
  includeUser: boolean;
  children: (scope: OwnerScope) => ReactNode;
}) {
  const { data: orgs, isPending, isError } = useQuery(organizationsListQuery());
  const scopes = useMemo(
    () => ownerScopes(orgs ?? [], { includeUser }),
    [orgs, includeUser],
  );

  return (
    <div className="space-y-6">
      {scopes.map(children)}
      {isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : isError ? (
        <p className="text-sm text-destructive">
          Failed to load organizations.
        </p>
      ) : scopes.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          You don't belong to any organization.
        </p>
      ) : null}
    </div>
  );
}

/** One scope's collapsible section: its name, whose it is, and the caller's
 * role there, with an item count and per-scope actions ("Add …"). */
export function OwnerScopeSection({
  scope,
  count,
  actions,
  children,
}: {
  scope: OwnerScope;
  count?: number;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <CollapsibleSection
      title={scope.label}
      count={count}
      meta={
        scope.orgId ? (
          <>
            {scope.mine ? <Badge variant="neutral">personal org</Badge> : null}
            <span className="text-xs text-muted-foreground">{scope.role}</span>
          </>
        ) : (
          <span className="text-xs text-muted-foreground">only you</span>
        )
      }
      actions={actions}
    >
      {children}
    </CollapsibleSection>
  );
}
