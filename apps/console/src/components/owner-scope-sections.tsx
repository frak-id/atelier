import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useMemo } from "react";
import { organizationsListQuery } from "@/api/queries/organizations";
import { Badge } from "@/components/ui/badge";
import { CollapsibleSection } from "@/components/ui/collapsible-section";
import { Skeleton } from "@/components/ui/skeleton";
import { type OwnerScope, ownerScopes } from "@/lib/orgs";

/**
 * Every org scope of an org-scoped settings page, one section each, instead
 * of a scope picker: the caller's personal org first, then every other org.
 * `children` renders one scope, usually as an `OwnerScopeSection`.
 */
export function OwnerScopeSections({
  children,
}: {
  children: (scope: OwnerScope) => ReactNode;
}) {
  const { data: orgs, isPending, isError } = useQuery(organizationsListQuery());
  const scopes = useMemo(() => ownerScopes(orgs ?? []), [orgs]);

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

/** One org's collapsible section: its name, personal/default flags and the
 * caller's role there, with an item count and per-scope actions ("Add …"). */
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
        <>
          {scope.mine ? <Badge variant="neutral">personal org</Badge> : null}
          {scope.isDefault ? <Badge variant="neutral">default</Badge> : null}
          <span className="text-xs text-muted-foreground">{scope.role}</span>
        </>
      }
      actions={actions}
    >
      {children}
    </CollapsibleSection>
  );
}
