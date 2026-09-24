import { useQuery } from "@tanstack/react-query";
import { organizationsListQuery } from "@/api/queries/organizations";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";

/**
 * Scope selector over the caller's owners for owner-scoped records
 * (toolboxes, Launchpad starters): the caller's own (`user`) plus each org
 * they belong to (`org:<id>`). The value is the `?owner=` string passed
 * straight to the API (`resolveOwner` on the server).
 */
export function OwnerScopeSelect({
  id,
  personalLabel,
  value,
  onChange,
}: {
  id: string;
  /** The caller's own scope, e.g. "My Toolboxes". */
  personalLabel: string;
  value: string;
  onChange: (owner: string) => void;
}) {
  const { data: orgs, isError } = useQuery(organizationsListQuery());
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>Scope</Label>
      <NativeSelect
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="user">{personalLabel}</option>
        {orgs?.map((org) => (
          <option key={org.id} value={`org:${org.id}`}>
            {org.name} (org)
          </option>
        ))}
      </NativeSelect>
      {isError ? (
        <p className="text-xs text-destructive">
          Failed to load organizations.
        </p>
      ) : null}
    </div>
  );
}
