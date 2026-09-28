import { useQuery } from "@tanstack/react-query";
import { organizationsListQuery } from "@/api/queries/organizations";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";

/**
 * Org-only scope selector for records that always belong to an organization
 * (Launchpad starters: the server requires `owner=org:<id>`, 400s on the
 * `user` scope). `value`/`onChange` carry the `?owner=org:<id>` string the
 * API takes directly — unlike `OwnerScopeSelect`, there is no personal
 * (`user`) option.
 */
export function OrgOwnerSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  /** An `org:<id>` scope string, or "" while the default is still loading. */
  value: string;
  onChange: (owner: string) => void;
}) {
  const { data: orgs, isError } = useQuery(organizationsListQuery());

  return (
    <div className="space-y-1">
      <Label htmlFor={id}>Organization</Label>
      <NativeSelect
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {orgs?.map((org) => (
          <option key={org.id} value={`org:${org.id}`}>
            {org.mine ? `${org.name} (personal)` : org.name}
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
